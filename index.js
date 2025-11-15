require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const twilio = require('twilio');

const app = express();

// --- ENV ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 5000;

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// --- SIMPLE QUALIFICATION FLOW ---

const QUALIFICATION_QUESTIONS = [
  { field: 'location', question: 'What area or city are you looking in?' },
  { field: 'home_type', question: 'What type of home are you looking for? (house, condo, apartment, etc.)' },
  { field: 'bedrooms', question: 'How many bedrooms do you need?' },
  { field: 'budget', question: 'What\'s your budget or price range?' },
  { field: 'timeline', question: 'When are you looking to move?' },
  { field: 'preapproval', question: 'Are you pre-approved for a mortgage or planning to pay cash?' },
  { field: 'motivation', question: 'What\'s motivating your move? (new job, bigger space, investment, etc.)' }
];

// --- HELPERS ---

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

// Save or update lead in Supabase
async function saveLeadToSupabase(phone, updates = {}) {
  const norm = normalizePhone(phone);
  const url = `${SUPABASE_URL}/rest/v1/leads?on_conflict=phone`;

  const data = {
    phone: norm,
    ...updates
  };

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal'
  };

  try {
    await axios.post(url, [data], { headers });
    console.log('✅ Lead saved/updated:', updates);
  } catch (err) {
    console.log('❌ Supabase error:', err.response?.data || err.message);
  }
}

// Save message to Supabase
async function saveMessageToSupabase(leadPhone, sender, message) {
  const url = `${SUPABASE_URL}/rest/v1/messages`;

  const data = {
    lead_phone: normalizePhone(leadPhone),
    sender: sender,
    message: message
  };

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal'
  };

  try {
    await axios.post(url, data, { headers });
    console.log('✅ Message saved:', sender, message.substring(0, 50) + '...');
  } catch (err) {
    console.log('❌ Message save error:', err.response?.data || err.message);
  }
}

// Get current lead state
async function getCurrentLeadState(phone) {
  const norm = normalizePhone(phone);
  const url = `${SUPABASE_URL}/rest/v1/leads?phone=eq.${norm}&select=*`;

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`
  };

  try {
    const { data } = await axios.get(url, { headers });
    if (data && data.length > 0) {
      return data[0];
    }
  } catch (err) {
    console.error('Error fetching lead state:', err);
  }

  // Return default state
  return {
    phone: norm,
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
    motivation: null
  };
}

// Score the lead based on responses
function calculateLeadScore(lead) {
  const fields = ['location', 'budget', 'timeline', 'home_type', 'bedrooms', 'preapproval', 'motivation'];
  
  // Count how many fields have real values (not null/empty/unknown)
  const filledCount = fields.filter(field => {
    const value = lead[field];
    return value && value !== 'unknown' && value.trim() !== '';
  }).length;

  // Check for urgency in timeline
  const timeline = lead.timeline ? lead.timeline.toLowerCase() : '';
  const isUrgent = timeline.includes('asap') || timeline.includes('soon') || 
                   timeline.includes('immediately') || timeline.includes('next month') ||
                   timeline.includes('30 day') || timeline.includes('2 week');

  // Check for strong budget indication
  const hasStrongBudget = lead.budget && !lead.budget.includes('unknown');

  // Scoring logic
  if (filledCount >= 5 && isUrgent && hasStrongBudget) return 'hot';
  if (filledCount >= 4) return 'warm';
  return 'cold';
}

// Check if user said yes to meeting
function isPositiveResponse(message) {
  if (!message) return false;
  
  const text = message.toLowerCase().trim();
  const positiveWords = [
    'yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 
    'sounds good', 'perfect', 'great', 'awesome',
    'bet', 'definitely', 'absolutely', 'lets do it', "let's do it",
    'schedule', 'call me', 'call', 'meeting'
  ];

  return positiveWords.some(word => text.includes(word));
}

// Update lead field based on current question and response
function updateLeadField(lead, currentQuestionIndex, userResponse) {
  if (currentQuestionIndex >= QUALIFICATION_QUESTIONS.length) return lead;
  
  const field = QUALIFICATION_QUESTIONS[currentQuestionIndex].field;
  const updatedLead = { ...lead };
  
  // Handle "I don't know" type responses
  if (userResponse.toLowerCase().includes('not sure') || 
      userResponse.toLowerCase().includes('don\'t know') ||
      userResponse.toLowerCase().includes('unknown') ||
      userResponse.toLowerCase().includes('idk')) {
    updatedLead[field] = 'unknown';
  } else {
    updatedLead[field] = userResponse;
  }
  
  return updatedLead;
}

// Get the next question or move to scheduling
// Get the next question or move to scheduling - FIXED VERSION
async function getNextStep(lead, userResponse) {
  const currentIndex = lead.current_question_index || 0;
  
  console.log('🔍 Current state:', {
    questionIndex: currentIndex,
    askedForMeeting: lead.asked_for_meeting,
    meetingScheduled: lead.meeting_scheduled
  });

  // If meeting already scheduled, just acknowledge - ADD THIS CHECK FIRST
  if (lead.meeting_scheduled) {
    console.log('✅ Meeting already scheduled - sending final message');
    return { type: 'already_handled', message: 'Thanks for your message! Our team will be in touch shortly.' };
  }

  // If we're still asking qualification questions
  if (currentIndex < QUALIFICATION_QUESTIONS.length) {
    // Update the current field with user's response
    const updatedLead = updateLeadField(lead, currentIndex, userResponse);
    
    // Move to next question
    updatedLead.current_question_index = currentIndex + 1;
    
    // If that was the last question, calculate score
    if (updatedLead.current_question_index === QUALIFICATION_QUESTIONS.length) {
      updatedLead.qualification_complete = true;
      updatedLead.lead_score = calculateLeadScore(updatedLead);
    }
    
    await saveLeadToSupabase(lead.phone, updatedLead);
    
    // Return next question or move to scheduling
    if (updatedLead.current_question_index < QUALIFICATION_QUESTIONS.length) {
      const nextQuestion = QUALIFICATION_QUESTIONS[updatedLead.current_question_index].question;
      return { type: 'question', message: nextQuestion };
    } else {
      // All questions answered - ask about scheduling
      updatedLead.asked_for_meeting = true;
      await saveLeadToSupabase(lead.phone, updatedLead);
      
      const score = updatedLead.lead_score;
      return { 
        type: 'scheduling', 
        message: `Thanks for the information! Based on what you've shared, you're a ${score} lead. Would you like to schedule a meeting with one of our agents?` 
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
      return { type: 'meeting_confirmed', message: 'Great! An agent will reach out soon to schedule the meeting.' };
    } else {
      // They said no or something else
      await saveLeadToSupabase(lead.phone, { 
        meeting_scheduled: true,
        wants_meeting: false 
      });
      return { type: 'meeting_declined', message: 'Thank you! We will reach out soon to discuss your options.' };
    }
  }
  
  // Fallback
  return { type: 'fallback', message: 'Thanks for your message! Our team will be in touch shortly.' };
}

// Main conversation handler
// Main conversation handler - FIXED VERSION
async function handleConversation(phone, userMessage) {
  console.log(`\n💬 Processing message from ${phone}: "${userMessage}"`);
  
  // Get current lead state - THIS IS CRITICAL
  let lead = await getCurrentLeadState(phone);
  console.log('📊 Current lead state:', {
    questionIndex: lead.current_question_index,
    complete: lead.qualification_complete,
    askedForMeeting: lead.asked_for_meeting,
    meetingScheduled: lead.meeting_scheduled,
    score: lead.lead_score
  });
  
  // Handle the conversation and get next step
  const nextStep = await getNextStep(lead, userMessage);
  console.log('🔄 Next step:', nextStep.type, '-', nextStep.message);
  
  return nextStep.message;
}

// --- ROUTES ---

app.get('/', (req, res) => {
  res.send('Real Estate AI Backend is running 🚀');
});

// Manual lead creation
app.post('/lead', async (req, res) => {
  try {
    const { name, phone, source } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }

    await saveLeadToSupabase(phone, { name, source: source || 'unknown' });
    
    // Start conversation with first question
    const firstQuestion = QUALIFICATION_QUESTIONS[0].question;
    await saveMessageToSupabase(phone, "ai", firstQuestion);

    res.json({ status: 'lead saved ✅', first_question: firstQuestion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to save lead' });
  }
});

// WhatsApp webhook
app.post('/whatsapp-webhook', async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body;

    console.log(`\n📱 INCOMING WHATSAPP from ${from}: "${body}"`);

    const leadPhone = normalizePhone(from);

    // Save incoming message
    await saveMessageToSupabase(leadPhone, "lead", body);

    // Generate response
    const aiReply = await handleConversation(leadPhone, body);
    
    // Save AI response
    await saveMessageToSupabase(leadPhone, "ai", aiReply);

    // Send via Twilio
    try {
      await client.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: from,
        body: aiReply
      });
      console.log('✅ Reply sent via Twilio');
    } catch (twilioErr) {
      console.error('❌ Twilio send error:', twilioErr.message);
    }

    res.status(200).send('');
  } catch (err) {
    console.error('❌ Error in webhook:', err);
    res.status(500).send('');
  }
});

// Get leads for frontend
app.get('/leads', async (req, res) => {
  const url = `${SUPABASE_URL}/rest/v1/leads?select=*`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`
  };

  try {
    const { data } = await axios.get(url, { headers });
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching leads:', err);
    res.status(500).json({ error: 'failed_to_fetch_leads' });
  }
});

// Get messages for a lead
app.get('/leads/:phone/messages', async (req, res) => {
  const phone = req.params.phone;
  const url = `${SUPABASE_URL}/rest/v1/messages?lead_phone=eq.${phone}&select=*&order=created_at.asc`;
  
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`
  };

  try {
    const { data } = await axios.get(url, { headers });
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'failed_to_fetch_messages' });
  }
});

// Agent reply
app.post('/leads/:phone/reply', async (req, res) => {
  const phone = req.params.phone;
  const { message } = req.body;

  if (!message?.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    // Save agent message
    await saveMessageToSupabase(phone, 'agent', message.trim());

    // Try to send via Twilio
    try {
      await client.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: `whatsapp:+${phone}`,
        body: message.trim()
      });
    } catch (twilioErr) {
      console.error('Twilio send error:', twilioErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error sending agent reply:', err);
    res.status(500).json({ error: 'failed_to_send_message' });
  }
});

// Update notes
app.patch('/leads/:phone/notes', async (req, res) => {
  const phone = req.params.phone;
  const { notes } = req.body;

  if (typeof notes !== 'string') {
    return res.status(400).json({ error: 'notes must be a string' });
  }

  const url = `${SUPABASE_URL}/rest/v1/leads?phone=eq.${phone}`;
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };

  try {
    const { data } = await axios.patch(url, { notes }, { headers });
    res.json({ success: true, lead: data?.[0] || null });
  } catch (err) {
    console.error('Error updating notes:', err);
    res.status(500).json({ error: 'failed_to_update_notes' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Real Estate Bot running on port ${PORT}`);
  console.log('📝 Qualification questions:', QUALIFICATION_QUESTIONS.length);
});
