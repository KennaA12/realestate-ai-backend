require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const twilio = require('twilio');

const app = express();

// ===== CONFIGURATION =====
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WHATSAPP_NUMBER,
  PORT = 5000
} = process.env;

// Validate required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ===== MIDDLEWARE =====
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173'], // React/Vite dev servers
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CONSTANTS =====
const QUALIFICATION_QUESTIONS = [
  { field: 'location', question: 'What area or city are you looking in?' },
  { field: 'home_type', question: 'What type of home are you looking for? (house, condo, apartment, etc.)' },
  { field: 'bedrooms', question: 'How many bedrooms do you need?' },
  { field: 'budget', question: 'What\'s your budget or price range?' },
  { field: 'timeline', question: 'When are you looking to move?' },
  { field: 'preapproval', question: 'Are you pre-approved for a mortgage or planning to pay cash?' },
  { field: 'motivation', question: 'What\'s motivating your move? (new job, bigger space, investment, etc.)' }
];

// ===== SUPABASE CONFIG =====
const supabaseHeaders = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal'
};

// ===== HELPER FUNCTIONS =====

/**
 * Normalize phone number by removing non-digit characters
 */
function normalizePhone(phone) {
  if (!phone) return '';
  // Remove all non-digit characters and extract the number
  const digits = phone.replace(/\D/g, '');
  // If it starts with 'whatsapp:+', extract just the number part
  if (phone.includes('whatsapp:+')) {
    return digits;
  }
  return digits;
}

/**
 * Save or update lead in Supabase
 */
async function saveLeadToSupabase(phone, updates = {}) {
  const normalizedPhone = normalizePhone(phone);
  
  const url = `${SUPABASE_URL}/rest/v1/leads?on_conflict=phone`;
  const data = {
    phone: normalizedPhone,
    ...updates,
    updated_at: new Date().toISOString()
  };

  try {
    const response = await axios.post(url, [data], { headers: supabaseHeaders });
    console.log('✅ Lead saved/updated:', { phone: normalizedPhone, ...updates });
    return { success: true, data: response.data };
  } catch (error) {
    console.error('❌ Supabase error saving lead:', {
      error: error.message,
      response: error.response?.data,
      phone: normalizedPhone
    });
    return { success: false, error: error.message };
  }
}

/**
 * Save message to Supabase
 */
async function saveMessageToSupabase(leadPhone, sender, message) {
  const normalizedPhone = normalizePhone(leadPhone);
  
  const url = `${SUPABASE_URL}/rest/v1/messages`;
  const data = {
    lead_phone: normalizedPhone,
    sender: sender,
    message: message.trim()
  };

  try {
    await axios.post(url, data, { headers: supabaseHeaders });
    console.log('✅ Message saved:', { 
      sender, 
      preview: message.substring(0, 50) + (message.length > 50 ? '...' : '') 
    });
    return { success: true };
  } catch (error) {
    console.error('❌ Error saving message:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get current lead state from Supabase
 */
async function getCurrentLeadState(phone) {
  const normalizedPhone = normalizePhone(phone);
  const url = `${SUPABASE_URL}/rest/v1/leads?phone=eq.${normalizedPhone}&select=*`;

  try {
    const { data } = await axios.get(url, { headers: supabaseHeaders });
    
    if (data && data.length > 0) {
      console.log('📊 Found existing lead:', data[0]);
      return data[0];
    }
    
    // Return default state for new lead
    console.log('🆕 Creating new lead state for:', normalizedPhone);
    return {
      phone: normalizedPhone,
      current_question_index: 0,
      qualification_complete: false,
      asked_for_meeting: false,
      meeting_scheduled: false,
      lead_score: null,
      location: null,
      home_type: null,
      bedrooms: null,
      budget: null,
      timeline: null,
      preapproval: null,
      motivation: null,
      created_at: new Date().toISOString()
    };
  } catch (error) {
    console.error('❌ Error fetching lead state:', error.message);
    // Return default state on error
    return {
      phone: normalizedPhone,
      current_question_index: 0,
      qualification_complete: false,
      asked_for_meeting: false,
      meeting_scheduled: false,
      lead_score: null,
      location: null,
      home_type: null,
      bedrooms: null,
      budget: null,
      timeline: null,
      preapproval: null,
      motivation: null,
      created_at: new Date().toISOString()
    };
  }
}

/**
 * Calculate lead score based on responses
 */
function calculateLeadScore(lead) {
  const fields = ['location', 'budget', 'timeline', 'home_type', 'bedrooms', 'preapproval', 'motivation'];
  
  // Count filled fields (not null/empty/unknown)
  const filledCount = fields.filter(field => {
    const value = lead[field];
    return value && value !== 'unknown' && value.toString().trim() !== '';
  }).length;

  // Check for urgency in timeline
  const timeline = (lead.timeline || '').toLowerCase();
  const isUrgent = timeline.includes('asap') || 
                   timeline.includes('soon') || 
                   timeline.includes('immediately') || 
                   timeline.includes('next month') ||
                   timeline.includes('30 day') || 
                   timeline.includes('2 week') ||
                   timeline.includes('urgent');

  // Check for strong budget indication
  const hasStrongBudget = lead.budget && 
                         !lead.budget.includes('unknown') && 
                         !lead.budget.includes('not sure');

  console.log('🎯 Lead scoring:', { filledCount, isUrgent, hasStrongBudget });

  // Scoring logic
  if (filledCount >= 5 && isUrgent && hasStrongBudget) return 'hot';
  if (filledCount >= 4) return 'warm';
  return 'cold';
}

/**
 * Check if user response is positive for scheduling
 */
function isPositiveResponse(message) {
  if (!message) return false;
  
  const text = message.toLowerCase().trim();
  const positiveWords = [
    'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 
    'sounds good', 'perfect', 'great', 'awesome',
    'bet', 'definitely', 'absolutely', 'lets do it', "let's do it",
    'schedule', 'call me', 'call', 'meeting', 'please', 'ready'
  ];

  return positiveWords.some(word => text.includes(word));
}

/**
 * Update lead field with user response
 */
function updateLeadField(lead, currentQuestionIndex, userResponse) {
  if (currentQuestionIndex >= QUALIFICATION_QUESTIONS.length) return lead;
  
  const field = QUALIFICATION_QUESTIONS[currentQuestionIndex].field;
  const updatedLead = { ...lead };
  
  const response = userResponse.trim();
  
  // Handle "I don't know" type responses
  if (response.toLowerCase().includes('not sure') || 
      response.toLowerCase().includes('don\'t know') ||
      response.toLowerCase().includes('unknown') ||
      response.toLowerCase().includes('idk') ||
      response.toLowerCase().includes('not certain')) {
    updatedLead[field] = 'unknown';
  } else {
    updatedLead[field] = response;
  }
  
  return updatedLead;
}

/**
 * Determine next step in conversation flow
 */
async function getNextStep(lead, userResponse) {
  const currentIndex = lead.current_question_index || 0;
  
  console.log('🔍 Conversation state:', {
    questionIndex: currentIndex,
    totalQuestions: QUALIFICATION_QUESTIONS.length,
    askedForMeeting: lead.asked_for_meeting,
    meetingScheduled: lead.meeting_scheduled
  });

  // If meeting already scheduled, just acknowledge
  if (lead.meeting_scheduled) {
    return { 
      type: 'already_handled', 
      message: 'Thanks for your message! Our team will be in touch shortly to confirm the meeting details.' 
    };
  }

  // If we're still asking qualification questions
  if (currentIndex < QUALIFICATION_QUESTIONS.length) {
    // Update current field with user's response
    const updatedLead = updateLeadField(lead, currentIndex, userResponse);
    
    // Move to next question
    updatedLead.current_question_index = currentIndex + 1;
    
    // If that was the last question, calculate score and mark complete
    if (updatedLead.current_question_index === QUALIFICATION_QUESTIONS.length) {
      updatedLead.qualification_complete = true;
      updatedLead.lead_score = calculateLeadScore(updatedLead);
      console.log('🎯 Qualification complete. Score:', updatedLead.lead_score);
    }
    
    // Save updated lead
    await saveLeadToSupabase(lead.phone, updatedLead);
    
    // Return next question or move to scheduling
    if (updatedLead.current_question_index < QUALIFICATION_QUESTIONS.length) {
      const nextQuestion = QUALIFICATION_QUESTIONS[updatedLead.current_question_index].question;
      return { type: 'question', message: nextQuestion };
    } else {
      // All questions answered - ask about scheduling
      await saveLeadToSupabase(lead.phone, { asked_for_meeting: true });
      
      const score = updatedLead.lead_score;
      const scoreEmoji = score === 'hot' ? '🔥' : score === 'warm' ? '☀️' : '❄️';
      
      return { 
        type: 'scheduling', 
        message: `${scoreEmoji} Thanks for the information! Based on what you've shared, you're a ${score} lead. Would you like to schedule a meeting with one of our agents?` 
      };
    }
  }
  
  // If we've asked about scheduling and got a response
  if (lead.asked_for_meeting && !lead.meeting_scheduled) {
    console.log('🔄 Processing scheduling response:', userResponse);
    
    if (isPositiveResponse(userResponse)) {
      // They said yes to meeting
      await saveLeadToSupabase(lead.phone, { 
        meeting_scheduled: true,
        wants_meeting: true,
        meeting_notes: userResponse
      });
      return { 
        type: 'meeting_confirmed', 
        message: '🎉 Great! An agent will reach out to you within the next hour to schedule the meeting. Thank you!' 
      };
    } else {
      // They said no or something else
      await saveLeadToSupabase(lead.phone, { 
        meeting_scheduled: true,
        wants_meeting: false 
      });
      return { 
        type: 'meeting_declined', 
        message: 'Thank you for your interest! We will keep your information on file and reach out if we find properties that match your criteria.' 
      };
    }
  }
  
  // Fallback for any unexpected state
  return { 
    type: 'fallback', 
    message: 'Thanks for your message! Our team will review your information and get back to you shortly.' 
  };
}

/**
 * Main conversation handler
 */
async function handleConversation(phone, userMessage) {
  console.log(`\n💬 Processing message from ${phone}: "${userMessage}"`);
  
  // Get current lead state
  const lead = await getCurrentLeadState(phone);
  
  // Handle the conversation and get next step
  const nextStep = await getNextStep(lead, userMessage);
  console.log('🔄 Next step:', nextStep.type);
  
  return nextStep.message;
}

/**
 * Send message via Twilio
 */
async function sendTwilioMessage(to, body) {
  try {
    const message = await twilioClient.messages.create({
      from: `whatsapp:${TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`,
      body: body
    });
    console.log('✅ Twilio message sent:', message.sid);
    return { success: true, messageId: message.sid };
  } catch (error) {
    console.error('❌ Twilio send error:', error.message);
    return { success: false, error: error.message };
  }
}

// ===== ROUTES =====

/**
 * Health check endpoint
 */
app.get('/', (req, res) => {
  res.json({ 
    status: '🚀 Real Estate AI Backend is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

/**
 * Test Supabase connection
 */
app.get('/test-supabase', async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/leads?limit=1`;
    const response = await axios.get(url, { headers: supabaseHeaders });
    
    res.json({
      status: '✅ Supabase connection successful',
      tables: ['leads', 'messages'],
      sampleData: response.data
    });
  } catch (error) {
    res.status(500).json({
      status: '❌ Supabase connection failed',
      error: error.message,
      supabaseUrl: SUPABASE_URL
    });
  }
});

/**
 * Manual lead creation
 */
app.post('/lead', async (req, res) => {
  try {
    const { name, phone, source } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ 
        error: 'Name and phone are required fields' 
      });
    }

    // Save lead to Supabase
    const saveResult = await saveLeadToSupabase(phone, { 
      name, 
      source: source || 'manual' 
    });

    if (!saveResult.success) {
      return res.status(500).json({ 
        error: 'Failed to save lead to database' 
      });
    }

    // Start conversation with first question
    const firstQuestion = QUALIFICATION_QUESTIONS[0].question;
    await saveMessageToSupabase(phone, "ai", firstQuestion);

    res.json({ 
      success: true,
      message: 'Lead created successfully',
      first_question: firstQuestion,
      lead: { name, phone, source }
    });
  } catch (error) {
    console.error('Error creating lead:', error);
    res.status(500).json({ 
      error: 'Internal server error creating lead',
      details: error.message 
    });
  }
});

/**
 * WhatsApp webhook (Twilio)
 */
app.post('/whatsapp-webhook', async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body;

    console.log(`\n📱 INCOMING WHATSAPP from ${from}: "${body}"`);

    // Save incoming message
    await saveMessageToSupabase(from, "lead", body);

    // Generate AI response
    const aiReply = await handleConversation(from, body);
    
    // Save AI response
    await saveMessageToSupabase(from, "ai", aiReply);

    // Send reply via Twilio
    const sendResult = await sendTwilioMessage(from, aiReply);

    if (!sendResult.success) {
      console.error('Failed to send Twilio message');
    }

    res.status(200).set('Content-Type', 'text/xml').send('');
  } catch (error) {
    console.error('❌ Error in WhatsApp webhook:', error);
    res.status(500).set('Content-Type', 'text/xml').send('');
  }
});

/**
 * Get all leads
 */
app.get('/leads', async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/leads?select=*&order=created_at.desc`;
    const response = await axios.get(url, { headers: supabaseHeaders });
    
    res.json({
      success: true,
      count: response.data.length,
      leads: response.data
    });
  } catch (error) {
    console.error('Error fetching leads:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch leads',
      details: error.message
    });
  }
});

/**
 * Get messages for a specific lead
 */
app.get('/leads/:phone/messages', async (req, res) => {
  try {
    const { phone } = req.params;
    const normalizedPhone = normalizePhone(phone);
    
    const url = `${SUPABASE_URL}/rest/v1/messages?lead_phone=eq.${normalizedPhone}&select=*&order=created_at.asc`;
    const response = await axios.get(url, { headers: supabaseHeaders });
    
    res.json({
      success: true,
      count: response.data.length,
      messages: response.data
    });
  } catch (error) {
    console.error('Error fetching messages:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch messages',
      details: error.message
    });
  }
});

/**
 * Agent reply to lead
 */
app.post('/leads/:phone/reply', async (req, res) => {
  try {
    const { phone } = req.params;
    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ 
        error: 'Message is required' 
      });
    }

    const normalizedPhone = normalizePhone(phone);

    // Save agent message
    await saveMessageToSupabase(normalizedPhone, 'agent', message);

    // Send via Twilio
    await sendTwilioMessage(`+${normalizedPhone}`, message);

    res.json({ 
      success: true,
      message: 'Reply sent successfully'
    });
  } catch (error) {
    console.error('Error sending agent reply:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send reply',
      details: error.message
    });
  }
});

/**
 * Update lead notes
 */
app.patch('/leads/:phone/notes', async (req, res) => {
  try {
    const { phone } = req.params;
    const { notes } = req.body;

    if (typeof notes !== 'string') {
      return res.status(400).json({ 
        error: 'Notes must be a string' 
      });
    }

    const normalizedPhone = normalizePhone(phone);
    const url = `${SUPABASE_URL}/rest/v1/leads?phone=eq.${normalizedPhone}`;
    
    const { data } = await axios.patch(
      url, 
      { notes }, 
      { headers: supabaseHeaders }
    );

    res.json({
      success: true,
      message: 'Notes updated successfully',
      lead: data?.[0] || null
    });
  } catch (error) {
    console.error('Error updating notes:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update notes',
      details: error.message
    });
  }
});

/**
 * 404 handler
 */
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl
  });
});

/**
 * Global error handler
 */
app.use((error, req, res, next) => {
  console.error('🚨 Global error handler:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// ===== SERVER STARTUP =====
app.listen(PORT, () => {
  console.log(`
🚀 Real Estate AI Bot running on port ${PORT}
-------------------------------------------
📊 Qualification Questions: ${QUALIFICATION_QUESTIONS.length}
🗄️  Supabase URL: ${SUPABASE_URL}
📱 Twilio WhatsApp: ${TWILIO_WHATSAPP_NUMBER}
-------------------------------------------
✅ Health check: http://localhost:${PORT}
✅ Supabase test: http://localhost:${PORT}/test-supabase
✅ Leads endpoint: http://localhost:${PORT}/leads
  `);
});
