import { NextResponse } from 'next/server';

interface NarrativeMemory {
  id: string;
  key: string;
  description: string;
  details: string;
  createdAt: string;
}

type NarrativeLanguage = 'zh' | 'en';

function toRelativeTimeLabel(isoLike: string, now: Date, language: NarrativeLanguage): string {
  const t = new Date(isoLike).getTime();
  if (Number.isNaN(t)) return language === 'zh' ? '较早之前' : 'some time ago';
  const diffMs = now.getTime() - t;
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.round(Math.abs(diffMs) / dayMs);
  const isPast = diffMs >= 0;

  if (language === 'zh') {
    if (days <= 1) return isPast ? '最近' : '很快';
    if (days < 7) return isPast ? `${days}天前` : `${days}天后`;
    if (days < 14) return isPast ? '大约一周前' : '大约一周后';
    if (days < 30) return isPast ? '几周前' : '几周后';
    if (days < 60) return isPast ? '大约一个月前' : '大约一个月后';
    if (days < 180) return isPast ? '几个月前' : '几个月后';
    if (days < 365) return isPast ? '数月前' : '数月后';
    const years = Math.max(1, Math.round(days / 365));
    return years === 1 ? (isPast ? '大约一年前' : '大约一年后') : (isPast ? `${years}年前` : `${years}年后`);
  }

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

function getIsoWeekOfYear(date: Date): number {
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function getTimeOfDayLabel(hours: number, language: NarrativeLanguage): string {
  if (language === 'zh') {
    if (hours < 5) return '凌晨';
    if (hours < 8) return '清晨';
    if (hours < 12) return '早上';
    if (hours < 14) return '中午';
    if (hours < 18) return '下午';
    if (hours < 20) return '傍晚';
    if (hours < 23) return '晚上';
    return '深夜';
  }

  if (hours < 5) return 'pre-dawn';
  if (hours < 8) return 'early morning';
  if (hours < 12) return 'morning';
  if (hours < 14) return 'midday';
  if (hours < 18) return 'afternoon';
  if (hours < 20) return 'early evening';
  if (hours < 23) return 'evening';
  return 'late night';
}

function buildNowContext(now: Date, language: NarrativeLanguage): string {
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now);
  const dateText = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const timeText = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const weekOfYear = getIsoWeekOfYear(now);
  const tod = getTimeOfDayLabel(now.getHours(), language);
  return language === 'zh'
    ? `${dateText} ${timeText}，${weekday}，第${weekOfYear}周，${tod}`
    : `${dateText} ${timeText}, ${weekday}, week ${weekOfYear}, ${tod}`;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureAllKeysMentioned(text: string, keys: string[], language: NarrativeLanguage): string {
  const clean = (text || '').trim();
  const missing = keys.filter((key) => {
    if (!key) return false;
    const re = new RegExp(escapeRegex(key), 'i');
    return !re.test(clean);
  });
  if (missing.length === 0) return clean;

  const bridge = language === 'zh'
    ? (missing.length === 1
      ? `${missing[0]} 仍在持续塑造这段记忆叙事。`
      : `${missing.join(', ')} 仍在持续塑造这段记忆叙事。`)
    : (missing.length === 1
      ? `${missing[0]} still kept shaping this memory narrative.`
      : `${missing.join(', ')} still kept shaping this memory narrative.`);

  return clean ? `${clean} ${bridge}` : bridge;
}

export async function POST(request: Request) {
  try {
    const { memories, language } = (await request.json()) as { memories: NarrativeMemory[]; language?: string };
    if (!memories || !Array.isArray(memories) || memories.length === 0) {
      return NextResponse.json({ error: 'Missing memories' }, { status: 400 });
    }
    const outputLanguage: NarrativeLanguage = language === 'en' ? 'en' : 'zh';

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
    const nowContext = buildNowContext(now, outputLanguage);

    const memoryDescriptions = memories
      .map(
        (m, i) => {
          const relTime = toRelativeTimeLabel(m.createdAt, now, outputLanguage);
          return `${i + 1}. (${relTime}) ${m.key}: ${m.description}${m.details ? ` — ${m.details}` : ''}`;
        }
      )
      .join('\n');

    const promptText = outputLanguage === 'zh'
      ? `你是一位叙事专家。请用中文写一段第一人称（“我”）的叙事性反思。

叙事要求：
- 必须包含每一个 memory key，并且 key 必须逐字一致（不可改写、不可翻译、不可缩写）。
- key 覆盖是强约束：若有任意 key 未出现，先重写再输出。
- key 必须保持纯文本（不要 markdown、不要引号、不要括号包裹），确保下游 UI 可以高亮和点击。
- 输出只能是中文；禁止输出英文句子（memory key 除外）。
- 输出只能是一段连续正文，不要项目符号和编号列表。
- 文风自然、克制、精简，不要刻意凑字数，不要絮叨。
- 以“当下视角”回看这些记忆：把现在时刻与过去经历放在同一叙事坐标里。
- 严禁臆测、严禁虚构、严禁补写未提供的环境细节；只允许使用输入中可验证的信息。
- 每个记忆节点（key 对应的那条记忆）在正文中只提一次，不要重复引用同一节点。
- 叙事顺序以给定时间序列为主线，按时间推进“先发生什么、后发生什么”。
- 在时间主线上提炼 insight 的发展过程：从早期认识到后续修正，再到当下理解。
- 不要只做流水账；在相邻记忆间明确关系（因果、对照、延续、情绪回响）。
- 要保留每条记忆的本质信息，同时维持整体叙事连续性与逻辑性。
- 保持第一人称“我”的叙述口吻，措辞尽量贴近记忆原描述风格。
- 输出形态采用“事实链 + 轻量 insight”：先交代事实推进，再给非常克制的理解。
- 不做人格判断或心理定性（例如“我太乐观/幼稚/冲动”这类结论）除非输入中有同义明确表述。
- 任何 insight 必须可被本段中已提及的输入事实直接支撑，不可额外推演。
- 结尾只允许事实性收束或低推断总结，不要主观评判式收尾。
- 不要开场免责声明，不要结尾加“总结”标签。

当前时刻语境（写作时必须纳入）：
${nowContext}

必须原样出现的 keys：
${requiredKeys.join(', ')}

可用记忆序列（含相对时间、Key、Description、Details）：
${memoryDescriptions}`
      : `You are a narrative expert. Write one concise first-person ("I") reflective passage in English.

Narrative rules:
- Include EVERY memory key exactly as-is (no rewriting, no translation, no abbreviation).
- Key coverage is mandatory: if any key is missing, rewrite before finalizing.
- Keep each key as plain text only (no markdown, no quotes, no brackets), so downstream UI can highlight and click it.
- Output must be English only; do not output Chinese text (except memory keys if they are provided that way).
- Output must be one flowing paragraph. Do not use bullets or numbered lists.
- Keep tone natural, restrained, and compact. Do not become verbose.
- Use a present-day viewpoint to revisit these memories, placing "now" and "then" in one narrative frame.
- No speculation, no fabrication, no invented environment details. Use only verifiable input facts.
- Mention each memory node (its key) once in the body; do not repeat the same node.
- Follow the given temporal order as the main spine: what happened first, then what happened next.
- On that temporal spine, explain how insights evolved: early understanding, later adjustment, and current interpretation.
- Avoid plain chronology only; make relations explicit (cause/effect, contrast, continuation, emotional echo).
- Preserve each memory's essential content while keeping continuity and logical coherence.
- Keep strict first-person voice ("I"), with wording close to the memory description style.
- Use a "fact chain + light insight" structure: facts first, then restrained interpretation.
- Do not make personality judgments or psychological labels (for example, "I was overly optimistic/naive/impulsive") unless equivalent wording exists explicitly in input.
- Every insight must be directly supported by facts already mentioned from input; no extra inference layers.
- End with factual closure or low-inference takeaway, not a subjective judgment-style ending.
- No opening disclaimer and no closing summary label.

Current-time context (must be incorporated):
${nowContext}

Required keys (must appear verbatim):
${requiredKeys.join(', ')}

Memory sequence to use (relative time, Key, Description, Details):
${memoryDescriptions}`;

    const body = {
      contents: [
        {
          parts: [
            {
              text: promptText,
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
    const narrative = ensureAllKeysMentioned(narrativeRaw, requiredKeys, outputLanguage);

    return NextResponse.json({ narrative: narrative.trim(), keyIdMap });
  } catch (err) {
    console.error('[narrative-text] error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
