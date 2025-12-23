import { DurableObject } from 'cloudflare:workers';

export class VerificationDO extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (request.method === 'POST' && path === '/start') {
			const { code } = (await request.json()) as { code: string };
			await this.ctx.storage.put('code', code);
			// 5 mins expiration for code
			await this.ctx.storage.setAlarm(Date.now() + 300 * 1000);
			return new Response('ok');
		}

		if (request.method === 'POST' && path === '/verify') {
			const { code: reqCode } = (await request.json()) as { code: string };
			const storedCode = await this.ctx.storage.get<string>('code');

			if (!storedCode || storedCode !== reqCode) {
				return new Response('Invalid code', { status: 400 });
			}

			// Mark as verified
			await this.ctx.storage.put('verified', '1');
			// Reset alarm to 5 mins for verified status expiration
			await this.ctx.storage.setAlarm(Date.now() + 300 * 1000);
			return new Response('ok');
		}

		if (request.method === 'GET' && path === '/status') {
			const verified = await this.ctx.storage.get<string>('verified');
			if (verified === '1') {
				return new Response(JSON.stringify({ status: 'verified' }), {
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({ status: 'pending' }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (request.method === 'DELETE' && path === '/') {
			await this.ctx.storage.deleteAll();
			return new Response('ok');
		}

		return new Response('Not found', { status: 404 });
	}

	async alarm() {
		await this.ctx.storage.deleteAll();
	}
}
