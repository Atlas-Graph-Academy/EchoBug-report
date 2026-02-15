import { NextResponse } from 'next/server';

interface ClusterSummary {
  id: number;
  texts: string[];
  dominantEmotion: string;
  size: number;
}

export async function POST(request: Request) {
  try {
    const { clusters } = (await request.json()) as { clusters: ClusterSummary[] };
    if (!clusters || !Array.isArray(clusters)) {
      return NextResponse.json({ error: 'Missing clusters' }, { status: 400 });
    }

    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!apiKey) {
      console.error('[cluster-names] GOOGLE_GENERATIVE_AI_API_KEY not set');
      return NextResponse.json({ error: 'API key not configured' }, { status: 500 });
    }

    const clusterDescriptions = clusters
      .map(
        (c) =>
          `Cluster ${c.id} (${c.size} memories, dominant emotion: ${c.dominantEmotion}):\n${c.texts.join('\n')}`
      )
      .join('\n\n');

    const body = {
      contents: [
        {
          parts: [
            {
              text: `You are labeling semantic clusters of personal memory descriptions. Each cluster groups similar memories by theme.

For each cluster below, generate a concise label (2-6 words in English, or 2-4 Chinese characters) that captures the SEMANTIC THEME — what the memories are about, not generic words.

Good labels: "Morning Commute", "Family Dinner", "Work Meetings", "街头观察", "咖啡与阅读"
Bad labels: "the", "and", "memories", "cluster"

Return ONLY a JSON array: [{"id": 0, "label": "..."}, ...]

${clusterDescriptions}`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 512,
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
      console.error('[cluster-names] Gemini API error:', resp.status, errText);
      return NextResponse.json({ error: 'Gemini API error', detail: errText }, { status: 502 });
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[cluster-names] Failed to parse Gemini response:', text.slice(0, 500));
      return NextResponse.json({ error: 'Failed to parse response', raw: text.slice(0, 200) }, { status: 502 });
    }

    const labels = JSON.parse(jsonMatch[0]) as { id: number; label: string }[];
    return NextResponse.json({ labels });
  } catch (err) {
    console.error('[cluster-names] error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
