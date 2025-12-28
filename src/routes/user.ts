import { Hono } from 'hono';
import { verify } from 'hono/jwt';
import type { Bindings, User } from '../types';
import { errorResp, JWT_SECRET } from '../utils';

const user = new Hono<{ Bindings: Bindings }>();

// Me
user.get('/me', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) return errorResp(c, 401, 'Authorization header required');

	const token = authHeader.replace('Bearer ', '');
	try {
		const payload = await verify(token, JWT_SECRET);
		// username is now PK
		const user = await c.env.DB.prepare(`SELECT username, qq FROM users WHERE username = ?`).bind(payload.user_id).first<User>();
		if (!user) return errorResp(c, 404, 'User not found');

		return c.json(user);
	} catch (_e) {
		return errorResp(c, 401, 'Invalid token');
	}
});

// List Users
user.get('/users', async (c) => {
	const users = await c.env.DB.prepare(`SELECT username, qq FROM users`).all<User>();
	const list = users.results.map((u) => ({
		name: u.username,
		id: u.username, // Using username as ID
		// link: u.link // Not in DB yet
	}));

	return c.json(list);
});

// Avatar Proxy
// Avatar Proxy
user.get('/user/avatar/:username', async (c) => {
	const username = c.req.param('username');
	const user = await c.env.DB.prepare(`SELECT username, qq, avatar FROM users WHERE username = ?`).bind(username).first<User>();

	if (!user) {
		return errorResp(c, 404, 'User not found');
	}

	// 1. Try R2 if avatar is set
	if (user.avatar) {
		const object = await c.env.BUCKET.get(user.avatar);
		if (object) {
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set('etag', object.httpEtag);
			return new Response(object.body, { headers });
		}
	}

	// 2. Fallback to QQ if available (and lazy upload)
	if (user.qq) {
		const avatarUrl = `https://q.qlogo.cn/headimg_dl?dst_uin=${user.qq}&spec=640&img_type=jpg`;
		const resp = await fetch(avatarUrl, {
			headers: { 'User-Agent': 'Mozilla/5.0' },
		});

		if (!resp.ok) {
			return errorResp(c, 502, 'Failed to fetch avatar from QQ');
		}

		// Lazy upload to R2
		const buffer = await resp.clone().arrayBuffer();
		const key = `avatars/${username}`;
		c.executionCtx.waitUntil(
			(async () => {
				await c.env.BUCKET.put(key, buffer, {
					httpMetadata: { contentType: resp.headers.get('Content-Type') || 'image/jpeg' },
				});
				await c.env.DB.prepare(`UPDATE users SET avatar = ? WHERE username = ?`).bind(key, username).run();
			})(),
		);

		return new Response(resp.body, {
			status: 200,
			headers: {
				'Content-Type': resp.headers.get('Content-Type') || 'image/jpeg',
				'Cache-Control': 'public, max-age=3600',
				'Access-Control-Allow-Origin': '*',
			},
		});
	}

	return errorResp(c, 404, 'Avatar not found');
});

// Upload Avatar
user.put('/user/avatar', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) return errorResp(c, 401, 'Authorization header required');

	const token = authHeader.replace('Bearer ', '');
	let username: string;
	try {
		const payload = await verify(token, JWT_SECRET);
		username = payload.user_id as string;
	} catch (_e) {
		return errorResp(c, 401, 'Invalid token');
	}

	const body = await c.req.parseBody();
	const file = body.avatar;

	if (!file || !(file instanceof File)) {
		return errorResp(c, 400, 'Avatar file required (multipart/form-data key "avatar")');
	}

	if (file.size > 1024 * 1024 * 5) {
		// 5MB limit
		return errorResp(c, 400, 'File too large (max 5MB)');
	}

	const key = `avatars/${username}`;
	await c.env.BUCKET.put(key, await file.arrayBuffer(), {
		httpMetadata: { contentType: file.type },
	});

	await c.env.DB.prepare(`UPDATE users SET avatar = ? WHERE username = ?`).bind(key, username).run();

	return c.json({ message: 'Avatar uploaded successfully', key });
});

export default user;
