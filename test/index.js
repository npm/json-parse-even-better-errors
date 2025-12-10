'use strict'

const { test } = require('node:test')
const assert = require('node:assert')
const parseJson = require('..')

const currentNodeMajor = +process.version.split('.')[0].slice(1)

// Given an object where keys are major versions of node, this will return the
// value where the current major version is >= the latest key. eg: in node 24,
// for the input {20:1, 22:2}, this will return 2 if not match is found it will
// return the value of the `default` key.
const getLatestMatchingNode = ({ default: defaultNode, ...majors }) => {
  for (const major of Object.keys(majors).sort((a, b) => b - a)) {
    if (currentNodeMajor >= major) {
      return majors[major]
    }
  }
  return defaultNode
}

// This will join all args into a regexp that can be used to assert a match.
// Each argument can be a string, regexp or an object passed to getLatestMatchingNode
const expectMessage = (...args) => new RegExp(args.map((rawValue) => {
  const value = rawValue.constructor === Object ? getLatestMatchingNode(rawValue) : rawValue
  return value instanceof RegExp ? value.source : value
}).join(''))

const jsonThrows = (data, ...args) => {
  let context
  if (typeof args[0] === 'number') {
    context = args.shift()
  }
  const expected = args[0]

  // If expected is an Error constructor or instance, use it directly
  if (typeof expected === 'function' || expected instanceof Error) {
    assert.throws(() => parseJson(data, null, context), expected)
    return
  }

  let err
  try {
    parseJson(data, null, context)
    assert.fail('Expected parseJson to throw')
  } catch (e) {
    err = e
  }

  if (expected.message) {
    if (expected.message instanceof RegExp) {
      assert.match(err.message, expected.message, 'error message should match pattern')
    } else {
      assert.strictEqual(err.message, expected.message, 'error message should match')
    }
  }
  if (expected.code) {
    assert.strictEqual(err.code, expected.code, 'error code should match')
  }
  if (expected.name) {
    assert.strictEqual(err.name, expected.name, 'error name should match')
  }
  if (expected.position !== undefined) {
    assert.strictEqual(err.position, expected.position, 'error position should match')
  }
  if (expected.systemError) {
    assert.ok(
      err.systemError instanceof expected.systemError,
      `systemError should be instance of ${expected.systemError.name}`
    )
  }
}

test('parses JSON', () => {
  const cases = Object.entries({
    object: {
      foo: 1,
      bar: {
        baz: [1, 2, 3, 'four'],
      },
    },
    array: [1, 2, null, 'hello', { world: true }, false],
    num: 420.69,
    null: null,
    true: true,
    false: false,
  }).map(([name, obj]) => [name, JSON.stringify(obj)])
  for (const [name, data] of cases) {
    // Use JSON.stringify for comparison to ignore Symbol properties
    assert.strictEqual(JSON.stringify(parseJson(data)), JSON.stringify(JSON.parse(data)), name)
  }
})

test('preserves indentation and newline styles', async () => {
  const kIndent = Symbol.for('indent')
  const kNewline = Symbol.for('newline')
  const object = { name: 'object', version: '1.2.3' }
  const array = [1, 2, 3, { object: true }, null]
  for (const newline of ['\n', '\r\n', '\n\n', '\r\n\r\n']) {
    for (const indent of ['', '  ', '\t', ' \t \t ']) {
      for (const [type, obj] of Object.entries({ object, array })) {
        const n = JSON.stringify({ type, newline, indent })
        const txt = JSON.stringify(obj, null, indent).replace(/\n/g, newline)
        await test(n, () => {
          const res = parseJson(txt)
          // no newline if no indentation
          assert.strictEqual(res[kNewline], indent && newline, 'preserved newline')
          assert.strictEqual(res[kIndent], indent, 'preserved indent')
        })
      }
    }
  }
})

test('indentation is the default when object/array is empty', async () => {
  const kIndent = Symbol.for('indent')
  const kNewline = Symbol.for('newline')
  const obj = '{}'
  const arr = '[]'
  for (const newline of ['', '\n', '\r\n', '\n\n', '\r\n\r\n']) {
    const expect = newline || '\n'
    for (const str of [obj, arr]) {
      await test(JSON.stringify({ str, newline, expect }), () => {
        const res = parseJson(str + newline)
        assert.strictEqual(res[kNewline], expect, 'got expected newline')
        assert.strictEqual(res[kIndent], '  ', 'got expected default indentation')
      })
    }
  }
})

test('parses JSON if it is a Buffer, removing BOM bytes', () => {
  const str = JSON.stringify({
    foo: 1,
    bar: {
      baz: [1, 2, 3, 'four'],
    },
  })
  const data = Buffer.from(str)
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data])
  assert.strictEqual(JSON.stringify(parseJson(data)), str)
  assert.strictEqual(JSON.stringify(parseJson(bom)), str, 'strips the byte order marker')
})

test('better errors when faced with \\b and other malarky', () => {
  const str = JSON.stringify({
    foo: 1,
    bar: {
      baz: [1, 2, 3, 'four'],
    },
  })
  const bombom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]),
    Buffer.from(str),
  ])

  jsonThrows(
    bombom,
    {
      message: /Unexpected token "." \(0xFEFF\)/,
    }
  )

  jsonThrows(str + '\b\b\b\b\b\b\b\b\b\b\b\b', {
    message: expectMessage(
      'Unexpected ',
      {
        20: 'non-whitespace character after JSON',
        default: /token "\\b" \(0x08\) in JSON/,
      },
      / at position.*\\b"/
    ),
  })
})

test('throws SyntaxError for unexpected token', () => {
  const data = 'foo'
  jsonThrows(data, {
    message: expectMessage(
      /Unexpected token "o" \(0x6F\)/,
      {
        20: ', "foo" is not valid JSON',
        default: ' in JSON at position 1',
      },
      / while parsing .foo./
    ),
    code: 'EJSONPARSE',
    position: getLatestMatchingNode({ 20: 0, default: 1 }),
    name: 'JSONParseError',
    systemError: SyntaxError,
  })
})

test('throws SyntaxError for unexpected end of JSON', () => {
  const data = '{"foo: bar}'
  jsonThrows(data, {
    message: expectMessage(
      {
        20: /Unterminated string in JSON at position \d+/,
        default: /Unexpected end of JSON input/,
      },
      /.* while parsing "{\\"foo: bar}"/
    ),
    code: 'EJSONPARSE',
    position: getLatestMatchingNode({ 20: 11, default: 10 }),
    name: 'JSONParseError',
    systemError: SyntaxError,
  })
})

test('throws SyntaxError for unexpected number', () => {
  const data = '[[1,2],{3,3,3,3,3}]'
  jsonThrows(data, {
    message: expectMessage(
      {
        20: "Expected property name or '}'",
        default: 'Unexpected number',
      },
      ' in JSON at position 8'
    ),
    code: 'EJSONPARSE',
    position: 8,
    name: 'JSONParseError',
    systemError: SyntaxError,
  })
})

test('SyntaxError with less context (limited start)', () => {
  const data = '{"6543210'
  jsonThrows(data, 3, {
    message: expectMessage(
      {
        20: 'Unterminated string in JSON at position 9',
        default: 'Unexpected end of JSON input',
      },
      /.* while parsing near "\.\.\./,
      {
        20: '210',
        default: '3210',
      }
    ),
    code: 'EJSONPARSE',
    position: getLatestMatchingNode({ 20: 9, default: 8 }),
    name: 'JSONParseError',
    systemError: SyntaxError,
  })
})

test('SyntaxError with less context (limited end)', () => {
  const data = 'abcde'
  jsonThrows(data, 2, {
    message: expectMessage(
      /Unexpected token "a" \(0x61\)/,
      {
        20: ', "abcde" is not valid JSON',
        default: ' in JSON at position 0',
      },
      /.* while parsing .*/,
      {
        20: "'abcd'",
        default: 'near "ab..."',
      }
    ),
    code: 'EJSONPARSE',
    position: 0,
    name: 'JSONParseError',
    systemError: SyntaxError,
  })
})

test('throws for end of input', () => {
  const data = '{"a":1,""'
  jsonThrows(data, 2, {
    message: expectMessage({
      22: `Expected ':' after property name in JSON at`,
      default: 'Unexpected end of JSON input while parsing',
    }),
    code: 'EJSONPARSE',
    position: getLatestMatchingNode({ 22: 9, default: 8 }),
    name: 'JSONParseError',
    systemError: SyntaxError,
  })
})

test('coverage on node 20', { skip: currentNodeMajor < 20 }, () => {
  assert.match(
    new parseJson.JSONParseError(
      { message: `Unexpected token \b at position 2` },
      'a'.repeat(4),
      1
    ).message,
    /Unexpected token/
  )
})

test('throws TypeError for undefined', () => {
  jsonThrows(undefined, new TypeError('Cannot parse undefined'))
})

test('throws TypeError for non-strings', () => {
  jsonThrows(new Map(), new TypeError('Cannot parse [object Map]'))
})

test('throws TypeError for empty arrays', () => {
  jsonThrows([], new TypeError('Cannot parse an empty array'))
})

test('handles empty string helpfully', () => {
  jsonThrows('', {
    message: 'Unexpected end of JSON input while parsing empty string',
    name: 'JSONParseError',
    position: 0,
    code: 'EJSONPARSE',
    systemError: SyntaxError,
  })
})

test('json parse error class', () => {
  assert.strictEqual(typeof parseJson.JSONParseError, 'function')

  // we already checked all the various index checking logic above
  const poop = new Error('poop')

  const fooShouldNotShowUpInStackTrace = () => {
    return new parseJson.JSONParseError(
      poop,
      'this is some json',
      undefined,
      bar
    )
  }
  const bar = () => fooShouldNotShowUpInStackTrace()
  const err1 = bar()
  assert.strictEqual(err1.systemError, poop, 'gets the original error attached')
  assert.strictEqual(err1.position, 0)
  assert.strictEqual(err1.message, `poop while parsing 'this is some json'`)
  assert.strictEqual(err1.name, 'JSONParseError')
  err1.name = 'something else'
  assert.strictEqual(err1.name, 'JSONParseError')
  assert.doesNotMatch(err1.stack, /fooShouldNotShowUpInStackTrace/)
  assert.strictEqual(err1[Symbol.toStringTag], 'JSONParseError', 'Symbol.toStringTag is correct')

  // calling it directly, tho, it does
  const fooShouldShowUpInStackTrace = () => {
    return new parseJson.JSONParseError(poop, 'this is some json')
  }
  const err2 = fooShouldShowUpInStackTrace()
  assert.strictEqual(err2.systemError, poop, 'gets the original error attached')
  assert.strictEqual(err2.position, 0)
  assert.strictEqual(err2.message, `poop while parsing 'this is some json'`)
  assert.match(err2.stack, /fooShouldShowUpInStackTrace/)
})

test('parse without exception', () => {
  const bad = 'this is not json'
  assert.strictEqual(parseJson.noExceptions(bad), undefined, 'does not throw')
  const obj = { this: 'is json' }
  const good = JSON.stringify(obj)
  assert.strictEqual(JSON.stringify(parseJson.noExceptions(good)), good, 'parses json string')
  const buf = Buffer.from(good)
  assert.strictEqual(JSON.stringify(parseJson.noExceptions(buf)), good, 'parses json buffer')
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf])
  assert.strictEqual(JSON.stringify(parseJson.noExceptions(bom)), good, 'parses json buffer with bom')
})
