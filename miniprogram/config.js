// The default is an explicit, device-local simulation. It never contacts the
// hosted website or uploads old demo records to a real account.
module.exports = { mode: 'mock', apiBase: '', requestTimeout: 15000 };
