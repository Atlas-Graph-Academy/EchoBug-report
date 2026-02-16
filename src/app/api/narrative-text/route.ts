import { NextResponse } from 'next/server';

interface NarrativeMemory {
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
              text: `你是一个回忆故事的讲述者。用第一人称「我」把下面这些记忆片段串成一段简短的内心独白。

规则：
- 每句话要短，像说话一样自然
- 把每条记忆的 key（用 **加粗** 标记）自然地嵌入句子中
- 不要用日期开头，不要列表，写成一整段流畅的文字
- 捕捉情绪变化和内在联系
- 总字数控制在 150-300 字
- 可以中英混用，保持原始 key 的语言
- 不要加开头语或结尾总结

Memories:
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

    return NextResponse.json({ narrative: narrative.trim() });
  } catch (err) {
    console.error('[narrative-text] error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
