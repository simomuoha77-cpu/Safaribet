/** Fail closed before importing the Express application and its route modules.
 * Route modules currently contain legacy process timers; importing them before
 * checking the Workers-supported Mongoose major would start those timers even
 * though the API runtime cannot be used.
 */
export function assertWorkersMongooseVersion(version) {
  const major = Number(String(version || '0').split('.')[0]);
  if (!Number.isInteger(major) || major < 9) {
    throw new Error(`Mongoose ${version || 'unknown'} is not supported on Workers; upgrade to Mongoose 9+ before enabling APIs`);
  }
  return true;
}
