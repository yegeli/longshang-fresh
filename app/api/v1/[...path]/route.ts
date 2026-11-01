import { env } from 'cloudflare:workers';
import { handleApi } from '../../../../server/cloud-api.js';
export const dynamic = 'force-dynamic';
const dispatch = (request: Request) => handleApi(request, env);
export { dispatch as GET, dispatch as POST, dispatch as PUT, dispatch as HEAD, dispatch as DELETE, dispatch as PATCH, dispatch as OPTIONS };
