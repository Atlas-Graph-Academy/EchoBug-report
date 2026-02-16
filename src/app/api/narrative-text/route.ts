import { NextResponse } from 'next/server';

interface NarrativeMemory {
  id: string;
  key: string;
  description: string;
  details: string;
  createdAt: string;
}

function toRelativeTimeLabel(isoLike: string, now: Date): string {
  const t = new Date(isoLike).getTime();
  if (Number.isNaN(t)) return 'some time ago';
  const diffMs = now.getTime() - t;
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.round(Math.abs(diffMs) / dayMs);
  const isPast = diffMs >= 0;

  const suffix = isPast ? 'ago' : 'later';
  if (days <= 1) return isPast ? 'recently' : 'very soon';
  if (days < 7) return `${days} days ${suffix}`;
  if (days < 14) return isPast ? 'about a week ago' : 'in about a week';
  if (days < 30) return isPast ? 'a few weeks ago' : 'in a few weeks';
  if (days < 60) return isPast ? 'about a month ago' : 'in about a month';
  if (days < 180) return isPast ? 'a few months ago' : 'in a few months';
  if (days < 365) return isPast ? 'several months ago' : 'several months later';
  const years = Math.max(1, Math.round(days / 365));
  return years === 1
    ? (isPast ? 'about a year ago' : 'about a year later')
    : `${years} years ${suffix}`;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureAllKeysMentioned(text: string, keys: string[]): string {
  const clean = (text || '').trim();
  const missing = keys.filter((key) => {
    if (!key) return false;
    const re = new RegExp(escapeRegex(key), 'i');
    return !re.test(clean);
  });
  if (missing.length === 0) return clean;

  const bridge = missing.length === 1
    ? `${missing[0]} also kept shaping how that story moved.`
    : `${missing.join(', ')} also kept shaping how that story moved.`;

  return clean ? `${clean} ${bridge}` : bridge;
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
    const requiredKeys = memories
      .map((m) => m.key?.trim())
      .filter((k): k is string => !!k);

    const memoryDescriptions = memories
      .map(
        (m, i) => {
          const relTime = toRelativeTimeLabel(m.createdAt, now);
          return `${i + 1}. (${relTime}) ${m.key}: ${m.description}${m.details ? ` — ${m.details}` : ''}`;
        }
      )
      .join('\n');

    const body = {
      contents: [
        {
          parts: [
            {
              text: `You are a professional storyteller. Write one concise first-person ("I") reflective passage in English.

Writing rules:
- Include EVERY memory key exactly as-is, at least once (no rewriting, no translation, no abbreviation).
- Key coverage is mandatory: if one key is missing, rewrite before finalizing.
- Keep each key text verbatim (same words and punctuation), so downstream UI matching can highlight and click it.
- Keep keys as plain text only (no markdown, no quotes, no brackets around keys).
- Do NOT output bullet points or numbered lists. One flowing paragraph.
- Do NOT start with a date.
- Start naturally with an approximate time context (for example: a few months ago, several days later), not with a clock-like timestamp.
- Keep it compact: around 120-220 words.
- Keep sentence style natural and spoken, but thoughtful.
- Do NOT narrate linearly only. Weave across time with flexible relative timing language.
- Explicitly connect memories through relationships (cause and effect, contrast, continuation, or emotional echo) so the links between nodes are clear.
- Integrate the whole set so each memory is understandable on its own while also contributing to a broader recall arc.
- Focus on emotional shifts, repeated patterns, turning points, and present-day meaning.
- No opening disclaimer and no closing summary label.

Required keys (must appear verbatim in the final paragraph):
${requiredKeys.join(', ')}

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
    const narrativeRaw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const narrative = ensureAllKeysMentioned(narrativeRaw, requiredKeys);

    return NextResponse.json({ narrative: narrative.trim(), keyIdMap });
  } catch (err) {
    console.error('[narrative-text] error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
