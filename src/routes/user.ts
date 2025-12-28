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
user.get('/user/avatar/:username', async (c) => {
	const username = c.req.param('username');
	const user = await c.env.DB.prepare(`SELECT qq FROM users WHERE username = ?`).bind(username).first<User>();

	if (!user || !user.qq) {
		return errorResp(c, 404, 'User or QQ not found');
	}

	const avatarUrl = `https://q.qlogo.cn/headimg_dl?dst_uin=${user.qq}&spec=640&img_type=jpg`;

	const resp = await fetch(avatarUrl, {
		headers: { 'User-Agent': 'Mozilla/5.0' },
	});

	if (!resp.ok) {
		return errorResp(c, 502, 'Failed to fetch avatar');
	}

	return new Response(resp.body, {
		status: 200,
		headers: {
			'Content-Type': resp.headers.get('Content-Type') || 'image/jpeg',
			'Cache-Control': 'public, max-age=3600',
			'Access-Control-Allow-Origin': '*',
		},
	});
});

export default user;
