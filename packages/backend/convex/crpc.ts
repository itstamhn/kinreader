import { initCRPC } from 'kitcn/server';

const crpc = initCRPC.create();

export const router = crpc.router;
export const query = crpc.query;
export const mutation = crpc.mutation;
export const action = crpc.action;
export const httpAction = crpc.httpAction;
export const middleware = crpc.middleware;
export default crpc;
