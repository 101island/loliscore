import { Hono } from 'hono';
import { verify } from 'hono/jwt';
import type { Bindings, User } from '../types';
import { errorResp, getHash, JWT_SECRET } from '../utils';

const user = new Hono<{ Bindings: Bindings }>();

// Me
user.get('/me', async (c) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader) return errorResp(c, 401, 'Authorization header required');

	const token = authHeader.replace('Bearer ', '');
	try {
		const payload = await verify(token, JWT_SECRET);
		// username is now PK
		const user = await c.env.DB.prepare(`SELECT username, qq, avatar FROM users WHERE username = ?`).bind(payload.user_id).first<User>();
		if (!user) return errorResp(c, 404, 'User not found');

		return c.json(user);
	} catch (_e) {
		return errorResp(c, 401, 'Invalid token');
	}
});

// List Users
user.get('/users', async (c) => {
	const users = await c.env.DB.prepare(`SELECT username, qq, avatar FROM users`).all<User>();

	// Process avatars in parallel to ensure all have hashes
	const processedUsers = await Promise.all(
		users.results.map(async (u) => {
			let avatar = u.avatar;

			// Check if avatar is valid hash (16 hex chars)
			const isValidHash = avatar && /^[0-9a-f]{16}$/.test(avatar);

			// If invalid/missing and we have QQ, try to restore
			if (!isValidHash && u.qq) {
				try {
					const avatarUrl = `https://q.qlogo.cn/headimg_dl?dst_uin=${u.qq}&spec=640&img_type=jpg`;
					const resp = await fetch(avatarUrl, {
						headers: { 'User-Agent': 'Mozilla/5.0' },
					});

					if (resp.ok) {
						const buffer = await resp.arrayBuffer();
						const hash = await getHash(buffer);
						const key = `avatar/${hash}`;

						// Upload to R2 and update DB if different (or if it was missing)
						// We do this in parallel to not block too much, but for the returned list we want the hash
						await c.env.BUCKET.put(key, buffer, {
							httpMetadata: {
								contentType: resp.headers.get('Content-Type') || 'image/jpeg',
							},
						});

						// Update DB
						await c.env.DB.prepare(`UPDATE users SET avatar = ? WHERE username = ?`).bind(hash, u.username).run();

						avatar = hash;
					}
				} catch (e) {
					console.error(`Failed to auto-migrate avatar for ${u.username}`, e);
				}
			}

			return {
				name: u.username,
				id: avatar, // Now should be hash if successful
			};
		}),
	);

	return c.json(processedUsers);
});

// Avatar Proxy or Direct Access
user.get('/user/avatar/:id', async (c) => {
	const id = c.req.param('id');

	// STRICT CHECK: id must be 16-char hex
	if (!/^[0-9a-f]{16}$/.test(id)) {
		return errorResp(c, 400, 'Invalid avatar hash');
	}

	try {
		// 1. Try fetching from R2 directly using the ID (hash)
		const key = `avatar/${id}`;
		const object = await c.env.BUCKET.get(key);

		if (object) {
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set('etag', object.httpEtag);
			return new Response(object.body, { headers });
		}

		// 2. If not found in R2, verify it exists in DB
		const user = await c.env.DB.prepare(`SELECT username, qq, avatar FROM users WHERE avatar = ?`).bind(id).first<User>();

		if (user?.qq) {
			// Restore avatar from QQ if local hash matches
			const avatarUrl = `https://q.qlogo.cn/headimg_dl?dst_uin=${user.qq}&spec=640&img_type=jpg`;
			const resp = await fetch(avatarUrl, {
				headers: { 'User-Agent': 'Mozilla/5.0' },
			});

			if (resp.ok) {
				const buffer = await resp.clone().arrayBuffer();
				const hash = await getHash(buffer);

				if (hash === id) {
					const newKey = `avatar/${hash}`;
					c.executionCtx.waitUntil(
						(async () => {
							await c.env.BUCKET.put(newKey, buffer, {
								httpMetadata: {
									contentType: resp.headers.get('Content-Type') || 'image/jpeg',
								},
							});
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
			}
		}

		return errorResp(c, 404, 'Avatar not found');
	} catch (e: unknown) {
		console.error(`Error fetching avatar for ${id}:`, e);
		return errorResp(c, 500, `Internal Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
	}
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

	// Initial size check (loose limit before processing)
	if (file.size > 1024 * 1024 * 5) {
		return errorResp(c, 400, 'File too large (max 5MB)');
	}

	try {
		// 1. Get current avatar before update
		const currentUser = await c.env.DB.prepare('SELECT avatar FROM users WHERE username = ?').bind(username).first<User>();
		const oldHash = currentUser?.avatar;

		const buffer = await file.arrayBuffer();

		// Keep upload path worker-compatible without native sharp
		if (buffer.byteLength > 300 * 1024) {
			return errorResp(c, 400, 'Image too large (>300KiB). Please upload a smaller image.');
		}

		const hash = await getHash(buffer);
		const key = `avatar/${hash}`;

		// 2. Upload new avatar
		await c.env.BUCKET.put(key, buffer, {
			httpMetadata: { contentType: file.type || 'application/octet-stream' },
		});

		// 3. Update DB
		await c.env.DB.prepare(`UPDATE users SET avatar = ? WHERE username = ?`).bind(hash, username).run();

		// 4. Delete old avatar if it changed and is unused
		if (oldHash && oldHash !== hash) {
			// Check if any other user is using the old avatar
			const usage = await c.env.DB.prepare('SELECT 1 FROM users WHERE avatar = ?').bind(oldHash).first();
			if (!usage) {
				// No one else uses it, delete from R2
				c.executionCtx.waitUntil(c.env.BUCKET.delete(`avatar/${oldHash}`));
			}
		}

		return c.json({ key: hash });
	} catch (e) {
		console.error('Image upload failed', e);
		return errorResp(c, 500, 'Failed to upload image');
	}
});

export default user;
