import { NextResponse } from 'next/server';

interface NarrativeMemory {
  id: string;
  key: string;
  description: string;
  details: string;
  createdAt: string;
}

export async function POST(request: Request) {
  try {
    const { memories } = (await request.json()) as { memories: NarrativeMemory[] };
    if (!memories || !Array.isArray(memories) || memories.length === 0) {
      return NextResponse.json({ error: 'Missing memories' }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      console.error('[narrative-text] GOOGLE_GENERATIVE_AI_API_KEY not set');
      return NextResponse.json({ error: 'API key not configured' }, { status: 500 });
    }

    // Build key→id mapping to return alongside narrative
    const keyIdMap: Record<string, string> = {};
    for (const m of memories) {
      if (m.key && m.id) keyIdMap[m.key] = m.id;
    }

    const now = new Date();
    const nowIso = now.toISOString();

    const memoryDescriptions = memories
      .map(
        (m, i) =>
          `${i + 1}. [${m.createdAt}] "${m.key}": ${m.description}${m.details ? ` — ${m.details}` : ''}`
      )
      .join('\n');

    const body = {
      contents: [
        {
          parts: [
            {
              text: `You are a memory narrator. Write one concise first-person ("I") reflective passage in English.

Current moment anchor:
- Current time is ${nowIso}
- The narration should feel grounded in "now", looking back across these memories.

Writing rules:
- Include EVERY memory key exactly as-is, at least once (no rewriting, no translation, no abbreviation).
- Keep keys as plain text only (no markdown, no quotes, no brackets around keys).
- Do NOT output bullet points or numbered lists. One flowing paragraph.
- Do NOT start with a date.
- Keep it compact: around 120-220 words.
- Keep sentence style natural and spoken, but thoughtful.
- Do NOT narrate linearly only. Weave across time: compare moments, show contrasts, and highlight how events/emotions evolved.
- Integrate the whole set so each memory is understandable on its own while also contributing to a broader recall arc.
- Focus on emotional shifts, repeated patterns, turning points, and present-day meaning.
- No opening disclaimer and no closing summary label.

Memories to weave:
${memoryDescriptions}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    };

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[narrative-text] Gemini API error:', resp.status, errText);
      return NextResponse.json({ error: 'Gemini API error', detail: errText }, { status: 502 });
    }

    const data = await resp.json();
    const narrative = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return NextResponse.json({ narrative: narrative.trim(), keyIdMap });
  } catch (err) {
    console.error('[narrative-text] error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
