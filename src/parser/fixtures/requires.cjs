// Fixture: CommonJS require() forms, including nested and non-literal calls.
const simple = require('./simple');
const { destructured, alsoDestructured } = require('./destructured');
const renamed = require('./renamed-source').inner;

function lazy() {
  // Nested inside a function body — the walk must find this, not just top level.
  return require('./lazy-inside-function');
}

const conditional = process.env.NODE_ENV === 'production' ? require('./prod') : require('./dev');

// Not a static dependency: the specifier is not a string literal. Must be skipped,
// never recorded with a bogus specifier.
const dynamicName = './computed';
const computed = require(dynamicName);

// A method named `require` on some other object is NOT a module import.
const notAnImport = someObject.require('./not-a-real-import');

module.exports = { simple, destructured, alsoDestructured, renamed, lazy, conditional, computed, notAnImport };
