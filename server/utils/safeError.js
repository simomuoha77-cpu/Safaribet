// safeError — logs the real error server-side, returns a generic message to the client.
// Never expose e.message directly in API responses: Mongoose/Mongo/vendor errors
// (field names, schema details, upstream service names, stack traces) are internal
// info that helps an attacker fingerprint the stack. Client only ever sees "message".
function safeError(res, e, context, status = 500, publicMessage = 'Something went wrong. Please try again.') {
  console.error(`[${context}]`, e && e.message ? e.message : e);
  return res.status(status).json({ success: false, message: publicMessage });
}

module.exports = safeError;
