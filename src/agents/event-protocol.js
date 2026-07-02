function makeEvent(type, fields) {
  return { type, ...fields };
}

module.exports = {
  makeEvent,
};
