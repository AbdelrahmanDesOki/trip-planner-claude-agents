import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import { ChatAnthropic } from "@langchain/anthropic";

const TripState = Annotation.Root({
  destination: Annotation({ reducer: (_, v) => v }),
  days: Annotation({ reducer: (_, v) => v }),
  budget: Annotation({ reducer: (_, v) => v }),
  people: Annotation({ reducer: (_, v) => v }),
  purpose: Annotation({ reducer: (_, v) => v }),
  accommodation: Annotation({ reducer: (_, v) => v }),
  searchResults: Annotation({ reducer: (_, v) => v }),
  budgetBreakdown: Annotation({ reducer: (_, v) => v }),
  itinerary: Annotation({ reducer: (_, v) => v }),
});

// In-memory cache keyed by "destination-days-budget-people"
const tripCache = new Map();

function cacheKey(destination, days, budget, people, purpose, accommodation) {
  return `${destination.toLowerCase().trim()}-${days}-${budget}-${people}-${purpose}-${accommodation}`;
}

function wrapWithProgress(name, nodeFn, onProgress) {
  return async (state) => {
    onProgress({ agent: name, status: "start" });
    const result = await nodeFn(state);
    onProgress({ agent: name, status: "done" });
    return result;
  };
}

async function searchNode(state) {
  const { destination, purpose, accommodation } = state;
  const model = new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
    maxTokens: 800,
  });

  const purposeLabels = {
    leisure: "Leisure / Holiday", honeymoon: "Honeymoon / Romantic",
    solo: "Solo Adventure", family: "Family with Kids", business: "Business + Leisure",
  };
  const accomLabels = {
    hotel: "Hotel / Resort", hostel: "Hostel", airbnb: "Airbnb / Apartment",
    boutique: "Boutique Hotel", luxury: "Luxury / 5-Star",
  };

  // Return structured JSON so the itinerary agent has less text to parse
  const prompt = `You are a travel research expert. Return ONLY valid JSON (no markdown, no code fences) for ${destination}.

Trip context:
- Purpose: ${purposeLabels[purpose] || purpose}
- Accommodation preference: ${accomLabels[accommodation] || accommodation}

Tailor your results to this context (e.g. for honeymoon focus on romantic spots; for family include kid-friendly venues; for luxury recommend upscale hotels only).

{
  "attractions": [
    { "name": "string", "description": "string", "entranceFee": "$XX", "suitableFor": "why it fits the trip purpose" }
  ],
  "hotels": [
    { "name": "string", "tier": "${accommodation}", "pricePerNight": "$XX", "notes": "why it fits" }
  ],
  "flightEstimate": "typical round-trip price range from major hubs",
  "bestTimeToVisit": "string",
  "localTransport": "string with options and rough costs"
}

Include 5-6 attractions suited to the trip purpose and 3 hotel options matching the accommodation type. Use realistic current prices.`;

  const response = await model.invoke(prompt);
  const raw = typeof response.content === "string"
    ? response.content
    : response.content[0]?.text || "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { raw: cleaned };
  }

  const searchResults = JSON.stringify(parsed);
  console.log(`[trip] Search results obtained (${searchResults.length} chars)`);
  return { searchResults };
}

async function budgetNode(state) {
  const { destination, days, budget, people, purpose, accommodation } = state;
  const model = new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
    maxTokens: 800,
  });

  const prompt = `You are a travel budget planning expert. Create a detailed budget breakdown for the following trip:

Destination: ${destination}
Duration: ${days} days
Total Budget: $${budget}
Number of travelers: ${people}
Trip Purpose: ${purpose}
Accommodation Type: ${accommodation}

Adjust cost estimates to match the trip purpose and accommodation type (e.g. luxury 5-star costs more; hostel is budget; honeymoon may include premium dining and experiences; family needs child activity costs).

Provide a clear breakdown of estimated costs per person per day for:
- Accommodation (matching the "${accommodation}" type)
- Food & dining (appropriate for "${purpose}" traveler)
- Local transportation
- Activities & entrance fees
- Miscellaneous expenses

Then summarize the total estimated cost vs the budget, and note if the budget is sufficient or not.
Be specific with dollar amounts.`;

  const response = await model.invoke(prompt);
  const budgetBreakdown = response.content || "";
  console.log(`[trip] Budget breakdown obtained (${budgetBreakdown.length} chars)`);
  return { budgetBreakdown };
}

async function itineraryNode(state) {
  const { destination, days, budget, people, purpose, accommodation, searchResults, budgetBreakdown } = state;
  const model = new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
    maxTokens: 800,
  });

  const prompt = `You are an expert travel itinerary planner. Create a detailed day-by-day itinerary based on the following information:

**Trip Details:**
- Destination: ${destination}
- Duration: ${days} days
- Total Budget: $${budget}
- Number of travelers: ${people}
- Trip Purpose: ${purpose}
- Accommodation Type: ${accommodation}

Personalize every aspect of the itinerary to match the trip purpose and accommodation type. For example:
- "honeymoon": candlelit dinners, couples spa, sunset viewpoints, romantic walks
- "family": kid-friendly museums, theme parks, early evenings, child menus
- "solo": hostels, social tours, local meetups, budget street food
- "business": central location, co-working spots, quick lunches, evening networking
- "luxury": fine dining, private tours, premium transport, 5-star amenities

**Research Findings:**
${searchResults}

**Budget Breakdown:**
${budgetBreakdown}

Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{
  "title": "Trip to [Destination]",
  "overview": "1-2 sentence trip summary",
  "accommodation": {
    "name": "Recommended hotel/hostel name",
    "pricePerNight": "$XX",
    "notes": "Why this is recommended"
  },
  "days": [
    {
      "day": 1,
      "title": "Short theme for the day",
      "morning": { "activity": "What to do", "location": "Where", "cost": "$XX" },
      "afternoon": { "activity": "What to do", "location": "Where", "cost": "$XX" },
      "evening": { "activity": "What to do", "location": "Where", "cost": "$XX" }
    }
  ],
  "budget": {
    "accommodation": 0,
    "food": 0,
    "transport": 0,
    "activities": 0,
    "misc": 0,
    "total": 0,
    "perPerson": 0,
    "verdict": "Under budget / Over budget by $XX"
  },
  "transportTips": ["tip1", "tip2", "tip3"],
  "diningTips": ["tip1", "tip2", "tip3"],
  "travelTips": ["tip1", "tip2", "tip3"]
}

Budget values must be numbers (no $ sign). Include exactly ${days} days. Be specific with real place names and realistic costs.`;

  return { itinerary: { _streamPrompt: prompt } };
}

function buildGraph(onProgress) {
  const graph = new StateGraph(TripState)
    .addNode("searchAgent", wrapWithProgress("search", searchNode, onProgress))
    .addNode("budgetAgent", wrapWithProgress("budget", budgetNode, onProgress))
    .addNode("itineraryAgent", wrapWithProgress("itinerary", itineraryNode, onProgress))
    .addEdge(START, "searchAgent")
    .addEdge(START, "budgetAgent")
    .addEdge("searchAgent", "itineraryAgent")
    .addEdge("budgetAgent", "itineraryAgent")
    .addEdge("itineraryAgent", END);

  return graph.compile();
}

export async function runTripPlanner({ destination, days, budget, people, purpose, accommodation, onProgress, onToken }) {
  console.log(`[trip] Starting trip planner for: ${destination}, ${days} days, $${budget}, ${people} people, ${purpose}, ${accommodation}`);

  const key = cacheKey(destination, days, budget, people, purpose, accommodation);
  if (tripCache.has(key)) {
    console.log(`[trip] Cache hit for: ${key}`);
    // Still emit agent statuses so the UI animates correctly
    onProgress({ agent: "search", status: "start" });
    onProgress({ agent: "search", status: "done" });
    onProgress({ agent: "budget", status: "start" });
    onProgress({ agent: "budget", status: "done" });
    onProgress({ agent: "itinerary", status: "start" });
    onProgress({ agent: "itinerary", status: "done" });
    return tripCache.get(key);
  }

  const graph = buildGraph(onProgress);
  const finalState = await graph.invoke({
    destination, days, budget, people, purpose, accommodation,
    searchResults: "", budgetBreakdown: "", itinerary: "",
  });

  // Stream the itinerary generation token by token
  const { _streamPrompt } = finalState.itinerary;
  const model = new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0,
    maxTokens: 2000,
  });

  let raw = "";
  const stream = await model.stream(_streamPrompt);
  for await (const chunk of stream) {
    const token = typeof chunk.content === "string"
      ? chunk.content
      : chunk.content[0]?.text || "";
    if (token) {
      raw += token;
      onToken(token);
    }
  }

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let itinerary;
  try {
    itinerary = JSON.parse(cleaned);
  } catch {
    console.error("[trip] Failed to parse itinerary JSON, raw:", cleaned.slice(0, 200));
    itinerary = cleaned;
  }

  console.log(`[trip] Itinerary generated (structured: ${typeof itinerary === "object"})`);
  tripCache.set(key, itinerary);
  return itinerary;
}
