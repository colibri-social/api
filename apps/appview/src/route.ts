import type { l } from "@atproto/lex-schema";
import type { AuthResult, LexMethodConfig, MethodAuthVerifier, Server } from "@atproto/xrpc-server";

export const route = <M extends l.Procedure | l.Query, A extends AuthResult>(
	server: Server,
	ns: l.Main<M>,
	config: LexMethodConfig<M, A> & { auth: MethodAuthVerifier<A> },
): void => {
	server.add<M, A>(ns, config as never);
};

export const publicRoute = <M extends l.Procedure | l.Query>(
	server: Server,
	ns: l.Main<M>,
	config: LexMethodConfig<M, void>,
): void => {
	server.add<M>(ns, config as never);
};
