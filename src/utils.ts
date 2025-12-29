import type { Context } from 'hono';

export const errorResp = (c: Context, status: number, msg: string) =>
	c.json(
		{ error: msg },
		// biome-ignore lint/suspicious/noExplicitAny: Hono status code casting
		status as any,
	);

// In a real app, this should definitely come from c.env, but keeping consistent with previous code for now.
// However, since we can't easily access c.env here without passing it, exporting a constant is fine for the secret key string if it's hardcoded.
// If it was meant to be env var, we'd access it inside handlers.
export const JWT_SECRET = 'your-secret-key-change-this';

export const getHash = async (data: ArrayBuffer | Uint8Array): Promise<string> => {
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	return hashHex.substring(0, 16);
};
