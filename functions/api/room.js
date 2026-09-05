const WORDS = [
  'apel', 'björk', 'dimma', 'eko', 'fjord', 'glimt', 'hav', 'is',
  'kaffe', 'kvist', 'lampa', 'ljus', 'mossa', 'natt', 'norr', 'oliv',
  'plommon', 'regn', 'sand', 'sippa', 'skog', 'sol', 'sten', 'stig',
  'sval', 'svala', 'tall', 'te', 'timme', 'vind', 'våg', 'äpple',
  'anka', 'bambu', 'bär', 'båt', 'dunge', 'eld', 'fågel', 'gryning',
  'humla', 'kulle', 'löv', 'måne', 'moln', 'odla', 'pärla', 'ro',
  'söder', 'torp', 'ugn', 'vila', 'äng', 'ö', 'blå', 'brasa',
  'dadel', 'famn', 'glänta', 'korn', 'nypa', 'ruta', 'snö', 'vindruva',
];

const ROOM_TTL_SECONDS = 15 * 60;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
}

function getCode(value) {
  const words = String(value || '').toLowerCase().trim().split(/[\s-]+/).filter(Boolean);
  if (words.length !== 4 || words.some((word) => !/^[a-zåäö0-9]{2,24}$/.test(word))) return '';
  return words.join('-');
}

function createCode() {
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => WORDS[value % WORDS.length]).join('-');
}

function hasDescription(description) {
  return description && (description.type === 'offer' || description.type === 'answer')
    && typeof description.sdp === 'string' && description.sdp.length > 100;
}

async function readRoom(context, code) {
  if (!context.env.ROOMS) return json({ error: 'ROOMS KV-binding saknas i Cloudflare.' }, 503);
  const room = await context.env.ROOMS.get(code, 'json');
  if (!room) return json({ error: 'Invite-koden finns inte längre eller är felstavad.' }, 404);
  return room;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost(context) {
  if (!context.env.ROOMS) return json({ error: 'ROOMS KV-binding saknas i Cloudflare.' }, 503);
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Ogiltig JSON.' }, 400);
  }
  if (!hasDescription(body?.offer)) return json({ error: 'Invite saknar en giltig WebRTC-offer.' }, 400);

  let code = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = createCode();
    if (!(await context.env.ROOMS.get(candidate))) {
      code = candidate;
      break;
    }
  }
  if (!code) return json({ error: 'Kunde inte skapa en unik invite. Försök igen.' }, 503);

  const createdAt = Date.now();
  const room = {
    offer: body.offer,
    answer: null,
    role: body.role === 'child' ? 'child' : 'parent',
    mode: body.mode === 'talkie' ? 'talkie' : 'monitor',
    video: Boolean(body.video),
    createdAt,
  };
  await context.env.ROOMS.put(code, JSON.stringify(room), { expirationTtl: ROOM_TTL_SECONDS });
  return json({ code, expiresAt: createdAt + ROOM_TTL_SECONDS * 1000 }, 201);
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const code = getCode(url.searchParams.get('code'));
  if (!code) return json({ error: 'Ange fyra invite-ord.' }, 400);
  const room = await readRoom(context, code);
  if (room instanceof Response) return room;
  return json({
    offer: room.offer,
    answer: room.answer,
    role: room.role,
    mode: room.mode,
    video: room.video,
    expiresAt: room.createdAt + ROOM_TTL_SECONDS * 1000,
  });
}

export async function onRequestPatch(context) {
  if (!context.env.ROOMS) return json({ error: 'ROOMS KV-binding saknas i Cloudflare.' }, 503);
  const url = new URL(context.request.url);
  const code = getCode(url.searchParams.get('code'));
  if (!code) return json({ error: 'Ange fyra invite-ord.' }, 400);
  const room = await readRoom(context, code);
  if (room instanceof Response) return room;
  let body;
  try {
    body = await context.request.json();
  } catch {
    return json({ error: 'Ogiltig JSON.' }, 400);
  }
  if (!hasDescription(body?.answer)) return json({ error: 'Svaret saknar en giltig WebRTC-answer.' }, 400);

  room.answer = body.answer;
  await context.env.ROOMS.put(code, JSON.stringify(room), { expirationTtl: ROOM_TTL_SECONDS });
  return json({ ok: true });
}
