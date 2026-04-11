const ANTHROPIC_API_KEY = () => Deno.env.get("ANTHROPIC_API_KEY")!;
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export async function askClaude(
  systemPrompt: string,
  messages: ChatMessage[],
  maxTokens = 1024,
): Promise<string> {
  const resp = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY(),
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error (${resp.status}): ${err}`);
  }

  const data = await resp.json();
  return data.content[0].text;
}

/**
 * Analyze a receipt image and extract structured data.
 */
export async function analyzeReceipt(base64Image: string, mimeType: string): Promise<{
  vendor: string;
  date: string;
  total: string;
  items: Array<{ description: string; amount: string }>;
}> {
  const resp = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY(),
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: base64Image,
              },
            },
            {
              type: "text",
              text: `Analysiere diesen Beleg/Quittung und extrahiere die Daten als JSON.
Antworte NUR mit einem JSON-Objekt in diesem Format:
{
  "vendor": "Name des Geschäfts/Lieferanten",
  "date": "YYYY-MM-DD",
  "total": "123.45",
  "items": [{"description": "Beschreibung", "amount": "12.50"}]
}
Falls etwas nicht lesbar ist, setze den Wert auf "unbekannt".`,
            },
          ],
        },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Receipt analysis failed: ${resp.status}`);
  }

  const data = await resp.json();
  const text = data.content[0].text;

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { vendor: "unbekannt", date: "unbekannt", total: "unbekannt", items: [] };
  }

  return JSON.parse(jsonMatch[0]);
}

/**
 * Use AI to understand natural language input and extract intent.
 */
export async function parseUserIntent(userMessage: string): Promise<{
  intent: "invoice" | "receipt" | "search" | "help" | "unknown";
  details?: string;
}> {
  const result = await askClaude(
    `Du bist ein Assistent für Schweizer Handwerker. Analysiere die Nachricht und bestimme die Absicht.
Antworte NUR mit JSON: {"intent": "invoice|receipt|search|help|unknown", "details": "optional extra info"}`,
    [{ role: "user", content: userMessage }],
    256,
  );

  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { intent: "unknown" };
  return JSON.parse(jsonMatch[0]);
}
