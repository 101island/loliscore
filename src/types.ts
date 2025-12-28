export type Bindings = {
	DB: D1Database;

	QBOT_TOKEN: string;
	VERIFICATION_DO: DurableObjectNamespace;
	BUCKET: R2Bucket;
};

export type User = {
	username: string;
	password?: string;
	qq?: string;
	avatar?: string;
};
