import express from "express";
import axios from "axios";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const toTable = process.env.toTable;
const fromTable = process.env.fromTable;
const MODEL = "google/gemini-2.0-flash-001";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !OPENROUTER_API_KEY) {
  console.error("❌ Missing required environment variables.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const args = process.argv.slice(2).join("");
let idList = [];

if (args.includes("-")) {
  const [min, max] = args.split("-").map(Number);
  idList = Array.from({ length: max - min + 1 }, (_, i) => min + i);
} else if (args.includes(",")) {
  idList = args.split(",").map(Number);
} else {
  console.error("❌ Invalid ID format. Use a range (e.g., 10-20) or a list (e.g., 5,7,9)");
  process.exit(1);
}

console.log(`🔍 Processing IDs: ${idList.join(", ")}`);

async function processDataWithAI(text) {
  if (!text || typeof text !== "string") {
    console.error("⚠️ Invalid input text:", text);
    return null;
  }

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: MODEL,
        temperature: 0.7,
        top_p: 0.9,
        messages: [
          {
            role: "system",
            content: `Generate a structured JSON response. It must contain a main title, a four-sentence main description, three additional titles, and three corresponding descriptions.

                        STRICT RULES:
                        - **DO NOT** return an empty object.
                        - **MUST** include all fields: "main_title", "main_description", "read_more_titles", and "read_more_descriptions".
                        - **If unable to generate valid content, return:** 
                          {
                            "main_title": "Default Title",
                            "main_description": "This is a default description containing exactly thirty words to ensure a structured response when valid content is not available.",
                            "read_more_titles": ["Title 1", "Title 2", "Title 3"],
                            "read_more_texts": [
                              "This is a placeholder description containing exactly two hundred words. It ensures a properly structured response even when no meaningful content is available. Repeat necessary words to maintain length.",
                              "Another placeholder description with exactly two hundred words, maintaining structured formatting for system compliance. Filler text continues as needed to match word count.",
                              "A final default description ensuring two hundred words in length. Placeholder content repeated and adjusted accordingly to fit the requirement for a complete and structured response."
                            ]
                          }
                        - **DO NOT** include markdown (\`json\`).
                        - **ONLY** return JSON, no extra text.`,
          },
          { role: "user", content: text.slice(0, 1000) },
        ],
        max_tokens: 800,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    let aiResponse = response.data.choices?.[0]?.message?.content || "{}";
    let jsonString = aiResponse.trim();

    jsonString = jsonString.replace(/```json|```/g, "").trim();

    try {
      return JSON.parse(jsonString);
    } catch (parseError) {
      console.error("❌ JSON Parse Error:", parseError.message);
      console.log("🔎 Raw JSON String:", jsonString);
      return null;
    }
  } catch (error) {
    console.error("❌ OpenRouter Error:", error.message);
    if (error.response) {
      console.log("🔍 Full API Error:", JSON.stringify(error.response.data, null, 2));
    }
    return null;
  }
}

async function processEntries() {
  for (const id of idList) {
    const { data: entry, error: fetchError } = await supabase
      .from(fromTable)
      .select("id, question, answer, category_display_name")
      .eq("id", id);

    if (fetchError) {
      console.error(`❌ Error fetching entry ID ${id}:`, fetchError.message);
      continue;
    }

    if (!entry || entry.length === 0) {
      console.log(`⚠️ No data found for ID ${id}. Skipping.`);
      continue;
    }

    const { question, answer, category_display_name } = entry[0];
    console.log(`🔍 Processing entry ID: ${id}`);

    const blogContent = await processDataWithAI(
      `${question} ${answer} ${category_display_name}`
    );

    if (!blogContent || !blogContent.main_title || !blogContent.main_description) {
      console.log(`⚠️ No valid AI-generated content. Skipping entry ID ${id}.`);
      continue;
    }

    const { error: insertError } = await supabase.from(toTable).insert({
      category_display_name,
      title: blogContent.main_title,
      description: blogContent.main_description,
      read_more_titles: blogContent.read_more_titles,
      read_more_texts: blogContent.read_more_descriptions,
    });

    if (insertError) {
      console.error(`❌ Error inserting entry ID ${id} into blogs:`, insertError.message);
      continue;
    }

    console.log(`✅ Processed and saved entry ID ${id} to blogs.`);
  }
}

processEntries();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
