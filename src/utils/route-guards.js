import { getOne } from '../db.js';

/**
 * Express middleware: load the agent at `req.params[paramName]`, confirm it
 * belongs to `req.orgId` (set by jwtMiddleware + requireAuth), attach the full
 * agent row to `req.agent`, or 404 if the agent doesn't exist or lives in
 * another org. Consolidates the 30+ route-handler copies of:
 *
 *   const agent = getOne('SELECT * FROM agents WHERE id = ? AND org_id = ?', [...])
 *   if (!agent) return res.status(404).json({ error: 'Agent not found' });
 *
 * Default param is `id` (matching most agent routes); pass `'agentId'` for
 * routes nested under `:agentId` like /api/agents/:agentId/memory.
 */
export function requireAgentInOrg(paramName = 'id') {
  return (req, res, next) => {
    const agentId = req.params[paramName];
    if (!agentId) return res.status(400).json({ error: 'Agent ID is required' });
    const agent = getOne(
      'SELECT * FROM agents WHERE id = ? AND org_id = ?',
      [agentId, req.orgId]
    );
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    req.agent = agent;
    next();
  };
}
