require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const twilio = require('twilio');
const OpenAI = require('openai');
const BOOKING_LINK = process.env.BOOKING_LINK;

const app = express();

// --- ENV ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const PORT = process.env.PORT || 5000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Global logger so we see every request
app.use((req, res, next) => {
  console.log('Incoming request:', req.method, req.url);
  next();
});

console.log('SUPABASE_URL:', SUPABASE_URL);
console.log('SUPABASE_KEY starts with:', SUPABASE_KEY?.slice(0, 5));
console.log('TWILIO_WHATSAPP_NUMBER:', process.env.TWILIO_WHATSAPP_NUMBER);

// --- HELPERS ---

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

// Save a lead row (used by /lead manual route)
async function saveLeadToSupabase(name, phone, source) {
  const url = `${SUPABASE_URL}/rest/v1/leads`;

  console.log('Posting to Supabase URL:', url);

  const data = {
    name,
    phone,
    source
  };

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal'
  };

  try {
    const resp = await axios.post(url, data, { headers });
    console.log('Supabase insert OK, status:', resp.status);
  } catch (err) {
    console.log('Supabase error status:', err.response?.status);
    console.log('Supabase error data:', err.response?.data || err.message);
    throw err;
  }
}

// Upsert lead fields (location, budget, etc.)
async function updateLeadFromState(phone, state) {
  const norm = normalizePhone(phone);
  const url = `${SUPABASE_URL}/rest/v1/leads?on_conflict=phone`;

  const row = {
    phone: norm
  };

  if (state.location) row.location = state.location;
  if (state.budget) row.budget = state.budget;
  if (state.timeline) row.timeline = state.timeline;
  if (state.home_type) row.home_type = state.home_type;
  if (state.bedrooms) row.bedrooms = state.bedrooms;
  if (state.preapproval) row.preapproval = state.preapproval;
  if (state.motivation) row.motivation = state.motivation;
  if (state.lead_score) row.lead_score = state.lead_score;

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal'
  };

  try {
    console.log('Upserting lead in Supabase for', norm, 'with', row);
    await axios.post(url, [row], { headers });
    console.log('✅ Lead upserted in Supabase');
  } catch (err) {
    console.error('❌ Supabase lead upsert error status:', err.response?.status);
    console.error('❌ Supabase lead upsert error data:', err.response?.data || err.message);
  }
}

// Save a message row (lead / ai / agent)
async function saveMessageToSupabase(leadPhone, sender, message) {
  const url = `${SUPABASE_URL}/rest/v1/messages`;

  const data = {
    lead_phone: leadPhone,
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
    console.log('Attempting to save message:', data);
    await axios.post(url, data, { headers });
    console.log('✅ Saved message to Supabase');
  } catch (err) {
    console.log('❌ Supabase message error status:', err.response?.status);
    console.log('❌ Supabase message error data:', err.response?.data || err.message);
  }
}

// Count how many fields are filled
function countKnownFields(state) {
  const keys = [
    "location",
    "budget",
    "timeline",
    "home_type",
    "bedrooms",
    "preapproval",
    "motivation"
  ];

  return keys.filter(k => {
    const v = state[k];
    return typeof v === 'string' && v.trim() !== '' && v !== 'unknown';
  }).length;
}

// Score lead: hot / warm / cold
async function scoreLeadFromState(state) {
  const knownCount = countKnownFields(state);

  const systemPrompt = `
You are scoring a real estate lead for an agent.

You will receive:
- A JSON object with these fields:
  location, budget, timeline, home_type, bedrooms, preapproval, motivation
- A count of how many of the 7 fields are filled.

Your job is to classify the lead as exactly one of:
- "hot"
- "warm"
- "cold"

Consider:
- "hot": Has budget, timeline (ASAP or near future), location, and motivation. Ready to move soon.
- "warm": Has some key info but missing urgency or key details.
- "cold": Very little info, vague answers, or far future timeline.

Return ONLY one word: "hot", "warm", or "cold".
`;

  const userPrompt = `
Known fields count: ${knownCount} out of 7.

Lead info as JSON:

${JSON.stringify(state, null, 2)}

Classify this lead now.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  const raw = completion.choices[0].message.content.trim().toLowerCase();
  console.log("Raw lead score:", raw);

  if (raw.includes("hot")) return "hot";
  if (raw.includes("warm")) return "warm";
  if (raw.includes("cold")) return "cold";

  return "warm";
}

// Fetch conversation history for a phone (normalized)
async function getConversationHistory(phone) {
  const norm = normalizePhone(phone);
  const url =
    `${SUPABASE_URL}/rest/v1/messages` +
    `?select=sender,message,created_at,lead_phone` +
    `&lead_phone=eq.${encodeURIComponent(norm)}` +
    `&order=created_at.asc`;

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`
  };

  try {
    const { data } = await axios.get(url, { headers });
    return data || [];
  } catch (err) {
    console.error('Error fetching conversation history:', err.response?.data || err.message);
    return [];
  }
}

// Extract structured state from full history
async function extractLeadStateFromHistory(phone) {
  const history = await getConversationHistory(phone);

  const convo = history
    .map(m => `${m.sender === 'ai' ? 'Assistant' : 'Lead'}: ${m.message}`)
    .join('\n');

  console.log("Full conversation for", phone, "=>", convo);

  const systemPrompt = `
You extract structured lead qualification info from a conversation between
a real estate assistant ("Assistant") and a lead ("Lead").

You must return ONLY valid JSON with this exact shape:

{
  "location": string | null,
  "budget": string | null,
  "timeline": string | null,
  "home_type": string | null,
  "bedrooms": string | null,
  "preapproval": string | null,
  "motivation": string | null
}

GENERAL RULES:
- The conversation is a sequence of turns: "Assistant:" and "Lead:".
- For every Lead message, you may use the immediately preceding Assistant message
  to understand what question the Lead is answering.
- If the Lead gives a very short answer (like just "5", "ASAP", "3-4 months", "not sure yet"),
  treat it as an answer to the LAST question asked by the Assistant.
- If the same type of info appears multiple times, ALWAYS use the MOST RECENT mention
  for that field (location, budget, timeline, home_type, bedrooms, preapproval, motivation).

GENERIC "DON'T KNOW" RULE (APPLIES TO ALL FIELDS):
- If the last Assistant question is clearly about ONE specific field
  (location, budget, timeline, home_type, bedrooms, preapproval, motivation),
  and the Lead replies with something like:
    "don't know yet"
    "dont know yet"
    "not sure yet"
    "no idea"
    "no clue"
    "none"
    "no preference"
    "haven't decided"
    "idk"
  then you MUST set THAT FIELD to the literal string "unknown" (NOT null),
  and do NOT change other fields.

FIELD RULES:

- LOCATION:
  - Any city, state, area, or neighborhood (e.g. "Dallas", "Phoenix", "near ASU").
  - Phrases like "Houses in Tempe", "Somewhere in Dallas", "a place in Maryland"
    MUST set location to the core place name: "Tempe", "Dallas", "Maryland".
  - If the last Assistant question is about where they want to live / location / area,
    and the Lead says a generic "not sure yet" type answer, then location = "unknown".

- BUDGET:
  - Any price or range for what they want to spend (e.g. "400k", "under 500k", "$2,000/month").
  - If they give a number or price phrase, use that as budget.
  - If the last Assistant question is about budget / price / what they want to spend,
    and they reply with a generic "don't know / none / not sure", then budget = "unknown".

- TIMELINE:
  - When they want to move (e.g. "next 3 months", "this summer", "ASAP", "3-4 years").
  - Look for time words: "month(s)", "year(s)", "week(s)", "ASAP", "soon", "later", "this fall", etc.
  - If the last Assistant question is about when they want to move / timeline / how soon,
    and they reply with a generic "not sure / no rush / haven't decided", then timeline = "unknown".
  - IMPORTANT:
    - If the Lead reply is ONLY a number or numeric range like "3-4" with NO time words,
      DO NOT treat it as timeline by itself.
    - Only assign to timeline if time units are explicitly mentioned, like "3-4 months" or "3-4 years".

- HOME TYPE:
  - Words like "house", "condo", "apartment", "townhouse", "duplex", etc.
  - If the last Assistant question asks what type of place or property they want,
    and they respond with "not sure / no preference / don't know", then home_type = "unknown".

- BEDROOMS:
  - Number of bedrooms (e.g. "3 bedrooms", "2-3 beds", "5 bed", or just "3", "3-4").
  - If the last Assistant question mentions "bedroom", "bedrooms", "beds", or "rooms",
    and the Lead replies with:
      - a single number (e.g. "5"), OR
      - a numeric range (e.g. "3-4", "2-3"),
    then that value MUST go to "bedrooms", NOT "timeline" and NOT any other field.
  - Examples:
      Assistant: "How many bedrooms are you looking for?"
      Lead: "5"
        => bedrooms: "5"
      Assistant: "How many bedrooms do you need?"
      Lead: "3-4"
        => bedrooms: "3-4"
  - If the last Assistant question is about bedrooms and they say "not sure" etc.,
    then bedrooms = "unknown".

- PREAPPROVAL:
  - Any mention of mortgage pre-approval or paying cash 
    (e.g. "pre-approved", "not pre-approved yet", "paying cash").
  - If the last Assistant question asks whether they are pre-approved or how they plan to finance,
    and they respond with "don't know yet / not sure", then preapproval = "unknown".

- MOTIVATION:
  - Why they are moving (e.g. "new job", "investment property", "bigger place", "going to ASU").
  - If the last Assistant question is about why they are moving / their reason / motivation,
    and they respond with "not sure", "no real reason", "just looking", then motivation = "unknown".

If something is not clearly mentioned, use null for that field.

Return ONLY JSON. No extra text.
`;

  const userPrompt = `
Here is the full conversation, one message per line:

${convo}

Now extract the JSON as described.
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });

  let raw = completion.choices[0].message.content.trim();
  console.log("Raw lead state JSON:", raw);

  try {
    const parsed = JSON.parse(raw);
    const state = {
      location: parsed.location ?? null,
      budget: parsed.budget ?? null,
      timeline: parsed.timeline ?? null,
      home_type: parsed.home_type ?? null,
      bedrooms: parsed.bedrooms ?? null,
      preapproval: parsed.preapproval ?? null,
      motivation: parsed.motivation ?? null
    };
    console.log("Parsed lead state for", phone, "=>", state);
    return state;
  } catch (e) {
    console.error("Failed to parse lead state JSON:", raw);
    return {
      location: null,
      budget: null,
      timeline: null,
      home_type: null,
      bedrooms: null,
      preapproval: null,
      motivation: null
    };
  }
}

// Simple yes-intent detector for calls
function messageIndicatesWantsCall(msg) {
  if (!msg) return false;
  const text = msg.toLowerCase();

  const yesWords = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'sounds good', 'bet', 'that works', 'perfect', 'great'];
  const callWords = ['call', 'phone', 'chat', 'talk', 'meeting', 'schedule', 'appointment'];

  const hasYes = yesWords.some(w => text.includes(w));
  const hasCall = callWords.some(w => text.includes(w));

  // Either explicit yes + call, or obvious "schedule" phrases
  if (hasYes && hasCall) return true;

  if (
    text.includes('schedule a call') ||
    text.includes('set up a call') ||
    text.includes('book a call') ||
    text.includes('schedule something') ||
    text.includes('that time works') ||
    text.includes('lets do it') ||
    text.includes("let's do it")
  ) {
    return true;
  }

  return false;
}

// Generate human-readable summary from state
function generateLeadSummary(state) {
  const parts = [];
  
  if (state.location && state.location !== 'unknown') {
    parts.push(`looking in ${state.location}`);
  }
  
  if (state.home_type && state.home_type !== 'unknown') {
    parts.push(`for a ${state.home_type}`);
  }
  
  if (state.bedrooms && state.bedrooms !== 'unknown') {
    parts.push(`with ${state.bedrooms} bedrooms`);
  }
  
  if (state.budget && state.budget !== 'unknown') {
    parts.push(`around ${state.budget}`);
  }
  
  if (state.timeline && state.timeline !== 'unknown') {
    parts.push(`planning to move ${state.timeline}`);
  }
  
  if (state.preapproval && state.preapproval !== 'unknown') {
    parts.push(`and they are ${state.preapproval}`);
  }
  
  if (state.motivation && state.motivation !== 'unknown') {
    parts.push(`because ${state.motivation}`);
  }
  
  if (parts.length === 0) {
    return "We're still learning about what you're looking for.";
  }
  
  return `Based on what you've shared, you're ${parts.join(', ')}.`;
}

// Generate smart reply with meeting scheduling and no repeated questions
async function generateSmartReply(phone, latestUserMessage) {
  // 1) Understand what info we already have from the whole history
  const state = await extractLeadStateFromHistory(phone);

  const raw = (latestUserMessage || '').trim();
  const lower = raw.toLowerCase();

  const looksUnknown =
    lower === 'idk' ||
    lower.includes("i don't know") ||
    lower.includes('dont know') ||
    lower.includes('not sure') ||
    lower.includes('no idea') ||
    lower === 'none';

  // If motivation is empty and this doesn't look like an "I don't know", use it as motivation
  if (
    (state.motivation === null || state.motivation === undefined || state.motivation === '') &&
    raw &&
    !looksUnknown
  ) {
    state.motivation = raw;
  }

  const fieldsInOrder = [
    'location',
    'budget',
    'timeline',
    'home_type',
    'bedrooms',
    'preapproval',
    'motivation'
  ];

  const labels = {
    location: 'the location or area they are looking in',
    budget: 'their budget or price range',
    timeline: 'when they want to move',
    home_type: 'the type of home they want (house, condo, townhouse, etc.)',
    bedrooms: 'how many bedrooms they want',
    preapproval: 'whether they are pre-approved or paying cash',
    motivation: 'why they are moving or buying'
  };

  // 2) Find the first truly missing field (not "unknown")
  const nextField = fieldsInOrder.find((field) => {
    const value = state[field];
    return value === null || value === '' || value === undefined;
  });

  // 3) Check if they just said yes to scheduling a meeting
  if (messageIndicatesWantsCall(latestUserMessage)) {
    return `Okay sounds good! Click this link to schedule the appointment: ${BOOKING_LINK}`;
  }

  let userInstruction;

  if (!nextField) {
    // We already have everything → send summary and ask about scheduling
    const summary = generateLeadSummary(state);
    
    userInstruction = `
The lead just said: "${latestUserMessage}".

You already have all the information needed. Here's the summary:
${summary}

Your job:
- Send them the summary above
- Ask if they'd like to schedule a call to discuss options
- Keep it casual and friendly
- Do NOT include the booking link yet - wait for them to say yes
- Keep it under 3 sentences total

Example: "${summary} Would you like to schedule a call to discuss your options?"
`;
  } else {
    // We still need ONE thing (e.g. timeline, bedrooms, etc.)
    userInstruction = `
The lead just said: "${latestUserMessage}".

So far you know this about them:
${JSON.stringify(state, null, 2)}

You STILL need to collect ONLY this missing piece: ${labels[nextField]}.

CRITICAL RULES TO PREVENT REPEATED QUESTIONS:
- DO NOT ask about any field that already has a value (even if it's "unknown")
- ONLY ask about the specific missing field: ${nextField}
- If the lead gives a vague answer like "idk" or "not sure", the system will mark that field as "unknown" and move on
- Never ask the same question twice in the conversation

Your job:
- Ask ONE short, natural question that focuses ONLY on ${labels[nextField]}
- You can briefly acknowledge what they said, but keep it very short
- Keep your response to 1-2 sentences, casual and friendly
- Vary your wording - don't always start with the same opener
- Make it sound like a natural conversation, not an interrogation

Respond with only the message you would send to the lead.
`;
  }

  const systemPrompt = `
You are a friendly real estate assistant chatting with a lead over WhatsApp.
You are also a highly structured real estate qualification assistant.

STYLE RULES:
- Sound like a real person texting, not a corporate bot.
- Do NOT always start with fillers like "Got it", "Okay", "Sure", "Alright", or "Sounds good".
- Vary your openers - sometimes start directly with the question or a short reaction
- Keep replies short (1-2 sentences), relaxed, and conversational
- Do not use emojis unless the lead uses them first
- Do not mention that you're using JSON, "fields", or a "checklist"

LOGIC RULES:
1. Use the JSON "known info" and the user instructions to decide what to say
2. You NEVER ask a question about a field that already has a value (including "unknown")
3. Identify which field is missing and ask ONLY about that one
4. Ask at most ONE focused question at a time
5. Your responses must be short, friendly, and natural (1-2 sentences)
6. NEVER contradict previously gathered information
7. If ALL 7 fields are filled:
   - Send them a summary of what they're looking for
   - Ask if they'd like to schedule a call
   - DO NOT include the booking link until they say yes to scheduling
8. If they say yes to scheduling a call, the system will automatically send the booking link
9. DO NOT mention fields, checklists, JSON, or that you're analyzing their answers
10. DO NOT ever ask the same question twice
11. If their latest message is unrelated (e.g. "yes", "okay"), continue with the next missing field
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.5, // slightly higher for more variety
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userInstruction }
    ]
  });

  return completion.choices[0].message.content.trim();
}

// Simple placeholder so /lead doesn't crash
async function generateLeadReply(name, source) {
  return `Hey ${name}, thanks for reaching out about real estate from ${source || 'your inquiry'}! An agent will follow up with you shortly.`;
}

// --- ROUTES ---

// Health check
app.get('/', (req, res) => {
  res.send('Real Estate AI Backend is running 🚀');
});

// Manual lead-creation route (not WhatsApp-based)
app.post('/lead', async (req, res) => {
  try {
    const { name, phone, source } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }

    await saveLeadToSupabase(name, phone, source || 'unknown');
    const aiMessage = await generateLeadReply(name, source || 'unknown');
    await saveMessageToSupabase(normalizePhone(phone), "ai", aiMessage);

    res.json({ status: 'lead saved ✅' });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'failed to save lead' });
  }
});

// Test route to verify messages-table logging
app.get('/test-log', async (req, res) => {
  try {
    await saveMessageToSupabase('TEST_PHONE', 'ai', 'This is a test message');
    res.send('Test message saved (or at least attempted). Check terminal and Supabase.');
  } catch (err) {
    res.status(500).send('Test failed');
  }
});

// Twilio WhatsApp webhook
app.post('/whatsapp-webhook', async (req, res) => {
  try {
    const from = req.body.From;  // "whatsapp:+1714..."
    const body = req.body.Body;  // lead's message text

    console.log('Incoming WhatsApp message:', from, body);

    const leadPhone = normalizePhone(from);

    // 1) Save incoming lead message
    await saveMessageToSupabase(leadPhone, "lead", body);

    // 2) Generate AI reply
    const aiReply = await generateSmartReply(leadPhone, body);

    // 3) Save AI reply
    await saveMessageToSupabase(leadPhone, "ai", aiReply);

    // 4) Re-extract state and update lead + score
    const state = await extractLeadStateFromHistory(leadPhone);
    const knownCount = countKnownFields(state);

    if (knownCount === 7) {
      const leadScore = await scoreLeadFromState(state);
      state.lead_score = leadScore;
    } else {
      state.lead_score = null;
    }

    await updateLeadFromState(leadPhone, state);

    // 5) Check if they want a meeting
    if (messageIndicatesWantsCall(body)) {
      const url = `${SUPABASE_URL}/rest/v1/leads?phone=eq.${leadPhone}`;
      const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      };

      try {
        await axios.patch(url, {
          wants_meeting: true,
          meeting_notes: body
        }, { headers });
        console.log('✅ Marked lead as wanting a meeting');
      } catch (err) {
        console.error('Error updating wants_meeting:', err.response?.data || err.message);
      }
    }

    // 6) Try Twilio send (but don't kill logic if it fails)
    try {
      await client.messages.create({
        from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
        to: from,
        body: aiReply
      });
    } catch (twilioErr) {
      console.error('Twilio send error:', twilioErr.code, twilioErr.message);
      if (twilioErr.code === 63038) {
        console.warn('⚠️ Hit Twilio daily message limit. Skipping send but keeping logic.');
      }
    }

    res.status(200).send('');
  } catch (err) {
    console.error('Error in /whatsapp-webhook:', err);
    res.status(500).send('');
  }
});

// Get leads for frontend
app.get('/leads', async (req, res) => {
  const url =
    `${SUPABASE_URL}/rest/v1/leads` +
    `?select=phone,name,source,location,budget,timeline,home_type,bedrooms,preapproval,motivation,lead_score,notes,wants_meeting,meeting_notes`;

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`
  };

  try {
    const { data } = await axios.get(url, { headers });
    res.json(data || []);
  } catch (err) {
    console.error('Error fetching leads from Supabase:', err.response?.data || err.message);
    res.status(500).json({ error: 'failed_to_fetch_leads' });
  }
});

// Get messages for a lead (for frontend)
app.get('/leads/:phone/messages', async (req, res) => {
  const phone = req.params.phone;

  const url =
    `${SUPABASE_URL}/rest/v1/messages` +
    `?select=sender,message,created_at,lead_phone` +
    `&lead_phone=eq.${encodeURIComponent(phone)}` +
    `&order=created_at.asc`;

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`
  };

  console.log('Fetching messages for lead:', phone, '->', url);

  try {
    const { data } = await axios.get(url, { headers });
    console.log('Messages from Supabase:', data);
    res.json(data || []);
  } catch (err) {
    console.error(
      'Error fetching messages from Supabase:',
      err.response?.data || err.message
    );
    res.status(500).json({ error: 'failed_to_fetch_messages' });
  }
});

// Agent reply from dashboard
app.post('/leads/:phone/reply', async (req, res) => {
  const phone = req.params.phone;
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const trimmed = message.trim();
  const toWhatsApp = `whatsapp:+${phone}`;
  let twilioError = null;

  console.log('Agent reply endpoint hit for', phone, 'message:', trimmed);

  // 1) Try sending via Twilio, but don't fail hard if it breaks
  try {
    await client.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: toWhatsApp,
      body: trimmed
    });
  } catch (err) {
    console.error('Error sending agent reply via Twilio:', err.message);
    twilioError = err.message;
  }

  // 2) Always try to save to Supabase as 'agent' message
  try {
    await saveMessageToSupabase(phone, 'agent', trimmed);
  } catch (err) {
    console.error('Failed to save agent message to Supabase:', err);
    return res.status(500).json({ error: 'failed_to_save_message' });
  }

  return res.json({ success: true, twilioError });
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
    return res.json({ success: true, lead: data?.[0] || null });
  } catch (err) {
    console.error('Error updating lead notes:', err.response?.data || err.message);
    return res.status(500).json({ error: 'failed_to_update_notes' });
  }
});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
