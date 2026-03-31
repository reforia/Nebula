/**
 * Build a dynamic SQL UPDATE from request body fields.
 *
 * @param {Object} body - The request body (e.g. req.body)
 * @param {string[]} allowedFields - Fields allowed to be updated
 * @param {Object} [converters] - Field-specific value converters
 *   Key: field name, Value: function(value) => transformed value
 *   Built-in shorthand: 'boolean' converts truthy to 1/0, 'trim' trims strings, 'json' stringifies objects
 * @returns {{ updates: string[], params: any[] }} Ready for SQL: `UPDATE ... SET ${updates.join(', ')} WHERE ...`
 *   Returns empty updates[] if no fields matched.
 *
 * @example
 * const { updates, params } = buildUpdate(req.body, ['name', 'enabled', 'config'], {
 *   name: 'trim',
 *   enabled: 'boolean',
 *   config: 'json',
 * });
 * if (updates.length > 0) {
 *   updates.push("updated_at = datetime('now')");
 *   params.push(id);
 *   run(`UPDATE my_table SET ${updates.join(', ')} WHERE id = ?`, params);
 * }
 */
export function buildUpdate(body, allowedFields, converters = {}) {
  const updates = [];
  const params = [];

  for (const field of allowedFields) {
    if (body[field] === undefined) continue;

    let val = body[field];
    const converter = converters[field];

    if (converter === 'boolean') {
      val = val ? 1 : 0;
    } else if (converter === 'trim') {
      val = typeof val === 'string' ? val.trim() : val;
    } else if (converter === 'json') {
      val = typeof val === 'object' ? JSON.stringify(val) : val;
    } else if (typeof converter === 'function') {
      val = converter(val);
    }

    updates.push(`${field} = ?`);
    params.push(val);
  }

  return { updates, params };
}
