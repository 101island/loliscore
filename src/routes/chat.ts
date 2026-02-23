import { type Context, Hono } from 'hono';
import { verify } from 'hono/jwt';
import type { Bindings } from '../types';
import { errorResp, JWT_SECRET } from '../utils';

const chat = new Hono<{ Bindings: Bindings }>();

type ChatMessage = {
	id: string;
	username: string;
	kind: 'text' | 'image';
	content: string;
	image_key: string | null;
	created_ms: number;
	created_at: string;
};

type ChatMessageOutput = {
	id: string;
	username: string;
	kind: 'text' | 'image';
	content: string;
	imageKey: string | null;
	createdMs: number;
	createdAt: string;
};

const IMAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{5,120}$/;
const EMOJI_PATTERN = /^\[\[\[([^:\]]+):([^\]]+)\]\]\]$/;
const MAX_IMAGE_BYTES = 512 * 1024;

const ensureChatSchema = async (db: D1Database) => {
	await db
		.prepare(
			"CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, username TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', image_key TEXT, created_ms INTEGER NOT NULL, created_at TEXT NOT NULL)",
		)
		.run();
	await db.prepare('CREATE INDEX IF NOT EXISTS idx_chat_messages_created_ms ON chat_messages (created_ms)').run();
};

const resolveUsername = async (token: string) => {
	const payload = await verify(token, JWT_SECRET);
	if (!payload?.user_id || typeof payload.user_id !== 'string') {
		throw new Error('Invalid token payload');
	}
	return payload.user_id;
};

const mapChatMessage = (row: ChatMessage): ChatMessageOutput => ({
	id: row.id,
	username: row.username,
	kind: row.kind === 'image' ? 'image' : 'text',
	content: row.content,
	imageKey: row.image_key,
	createdMs: row.created_ms,
	createdAt: row.created_at,
});

chat.get('/chat/messages', async (c) => {
	await ensureChatSchema(c.env.DB);

	const rawLimit = Number(c.req.query('limit') || '30');
	const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 30;
	const before = Number(c.req.query('before') || '0');

	const query =
		before > 0
			? c.env.DB.prepare(
					'SELECT id, username, kind, content, image_key, created_ms, created_at FROM chat_messages WHERE created_ms < ? ORDER BY created_ms DESC LIMIT ?',
				).bind(before, limit)
			: c.env.DB.prepare(
					'SELECT id, username, kind, content, image_key, created_ms, created_at FROM chat_messages ORDER BY created_ms DESC LIMIT ?',
				).bind(limit);

	const result = await query.all<ChatMessage>();
	const messages = result.results.map(mapChatMessage);

	return c.json({ messages: messages.reverse() });
});

chat.get('/chat/stream', async (c) => {
	await ensureChatSchema(c.env.DB);

	let since = Number(c.req.query('since') || '0');
	if (!Number.isFinite(since) || since < 0) since = 0;

	const encoder = new TextEncoder();
	let closed = false;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const sendEvent = (event: string, payload: unknown) => {
				if (closed) return;
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
			};

			const sendPing = () => {
				if (closed) return;
				controller.enqueue(encoder.encode(': ping\n\n'));
			};

			const closeStream = () => {
				if (closed) return;
				closed = true;
				if (pollTimer) clearInterval(pollTimer);
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				try {
					controller.close();
				} catch {}
			};

			const queryUpdates = async () => {
				if (closed) return;
				try {
					const result = await c.env.DB.prepare(
						'SELECT id, username, kind, content, image_key, created_ms, created_at FROM chat_messages WHERE created_ms > ? ORDER BY created_ms ASC LIMIT 50',
					)
						.bind(since)
						.all<ChatMessage>();

					if (result.results.length === 0) return;

					const messages = result.results.map(mapChatMessage);
					since = messages[messages.length - 1].createdMs;
					sendEvent('messages', { messages });
				} catch {
					closeStream();
				}
			};

			sendEvent('ready', { now: Date.now() });
			void queryUpdates();

			pollTimer = setInterval(() => {
				void queryUpdates();
			}, 1500);

			heartbeatTimer = setInterval(sendPing, 20000);

			c.req.raw.signal.addEventListener('abort', closeStream, { once: true });
		},
		cancel() {
			closed = true;
			if (pollTimer) clearInterval(pollTimer);
			if (heartbeatTimer) clearInterval(heartbeatTimer);
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
		},
	});
});

chat.post('/chat/messages', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) return errorResp(c, 401, 'Authorization header required');

	const token = authHeader.replace('Bearer ', '').trim();
	let username = '';
	try {
		username = await resolveUsername(token);
	} catch {
		return errorResp(c, 401, 'Invalid token');
	}

	await ensureChatSchema(c.env.DB);

	const payload = await c.req.json<{ text?: string; imageKey?: string }>();
	const text = typeof payload.text === 'string' ? payload.text.trim() : '';
	const imageKey = typeof payload.imageKey === 'string' ? payload.imageKey : '';

	if (!text && !imageKey) return errorResp(c, 400, 'Message is empty');
	if (text.length > 2000) return errorResp(c, 400, 'Message too long');
	if (imageKey && !IMAGE_KEY_PATTERN.test(imageKey)) return errorResp(c, 400, 'Invalid image key');

	if (text) {
		const emoji = text.match(EMOJI_PATTERN);
		if (emoji && (emoji[1].length > 32 || emoji[2].length > 32)) {
			return errorResp(c, 400, 'Emoji token is too long');
		}
	}

	const createdMs = Date.now();
	const id = `${createdMs}-${crypto.randomUUID().slice(0, 8)}`;
	const createdAt = new Date(createdMs).toISOString();
	const kind = imageKey ? 'image' : 'text';

	await c.env.DB.prepare(
		'INSERT INTO chat_messages (id, username, kind, content, image_key, created_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
	)
		.bind(id, username, kind, text, imageKey || null, createdMs, createdAt)
		.run();

	return c.json({
		message: {
			id,
			username,
			kind,
			content: text,
			imageKey: imageKey || null,
			createdMs,
			createdAt,
		},
	});
});

const deleteOwnMessage = async (c: Context<{ Bindings: Bindings }>) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) return errorResp(c, 401, 'Authorization header required');

	const token = authHeader.replace('Bearer ', '').trim();
	let username = '';
	try {
		username = await resolveUsername(token);
	} catch {
		return errorResp(c, 401, 'Invalid token');
	}

	await ensureChatSchema(c.env.DB);

	const messageId = c.req.param('id').trim();
	if (!messageId) return errorResp(c, 400, 'Message id is required');

	const row = await c.env.DB.prepare('SELECT username, image_key FROM chat_messages WHERE id = ? LIMIT 1')
		.bind(messageId)
		.first<{ username: string; image_key: string | null }>();

	if (!row) return errorResp(c, 404, 'Message not found');
	if (row.username !== username) return errorResp(c, 403, 'Cannot withdraw this message');

	await c.env.DB.prepare('DELETE FROM chat_messages WHERE id = ? AND username = ?').bind(messageId, username).run();

	if (row.image_key && IMAGE_KEY_PATTERN.test(row.image_key)) {
		c.executionCtx.waitUntil(c.env.BUCKET.delete(`chat/${row.image_key}`));
	}

	return c.json({ ok: true });
};

chat.delete('/chat/messages/:id', deleteOwnMessage);
chat.post('/chat/messages/:id/withdraw', deleteOwnMessage);

const extensionFromType = (type: string) => {
	if (type === 'image/png') return 'png';
	if (type === 'image/gif') return 'gif';
	if (type === 'image/webp') return 'webp';
	return 'jpg';
};

chat.post('/chat/images', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) return errorResp(c, 401, 'Authorization header required');

	const token = authHeader.replace('Bearer ', '').trim();
	try {
		await resolveUsername(token);
	} catch {
		return errorResp(c, 401, 'Invalid token');
	}

	const body = await c.req.parseBody();
	const file = body.image;

	if (!(file instanceof File)) {
		return errorResp(c, 400, 'Image file required (multipart/form-data key "image")');
	}
	if (file.type !== 'image/webp') return errorResp(c, 400, 'Only webp image is allowed');
	if (file.size > MAX_IMAGE_BYTES) return errorResp(c, 400, 'Image is too large (max 512KiB)');

	const ext = extensionFromType(file.type);
	const key = `${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}.${ext}`;
	await c.env.BUCKET.put(`chat/${key}`, await file.arrayBuffer(), {
		httpMetadata: {
			contentType: file.type,
		},
	});

	return c.json({
		key,
		url: `/api/chat/images/${key}`,
	});
});

chat.get('/chat/images/:key', async (c) => {
	const key = c.req.param('key');
	if (!IMAGE_KEY_PATTERN.test(key)) {
		return errorResp(c, 404, 'Image not found');
	}

	const object = await c.env.BUCKET.get(`chat/${key}`);
	if (!object) return errorResp(c, 404, 'Image not found');

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	return new Response(object.body, { headers });
});

export default chat;
