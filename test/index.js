'use strict'

const t = require('tap')
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

const jsonThrows = (t, data, ...args) => {
  let context
  if (typeof args[0] === 'number') {
    context = args.shift()
  }
  return t.throws(() => parseJson(data, null, context), ...args)
}

t.test('parses JSON', (t) => {
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
  t.plan(cases.length)
  for (const [name, data] of cases) {
    t.same(parseJson(data), JSON.parse(data), name)
  }
})

t.test('preserves indentation and newline styles', (t) => {
  const kIndent = Symbol.for('indent')
  const kNewline = Symbol.for('newline')
  const object = { name: 'object', version: '1.2.3' }
  const array = [1, 2, 3, { object: true }, null]
  for (const newline of ['\n', '\r\n', '\n\n', '\r\n\r\n']) {
    for (const indent of ['', '  ', '\t', ' \t \t ']) {
      for (const [type, obj] of Object.entries({ object, array })) {
        const n = JSON.stringify({ type, newline, indent })
        const txt = JSON.stringify(obj, null, indent).replace(/\n/g, newline)
        t.test(n, (t) => {
          const res = parseJson(txt)
          // no newline if no indentation
          t.equal(res[kNewline], indent && newline, 'preserved newline')
          t.equal(res[kIndent], indent, 'preserved indent')
          t.end()
        })
      }
    }
  }
  t.end()
})

t.test('indentation is the default when object/array is empty', (t) => {
  const kIndent = Symbol.for('indent')
  const kNewline = Symbol.for('newline')
  const obj = '{}'
  const arr = '[]'
  for (const newline of ['', '\n', '\r\n', '\n\n', '\r\n\r\n']) {
    const expect = newline || '\n'
    for (const str of [obj, arr]) {
      t.test(JSON.stringify({ str, newline, expect }), (t) => {
        const res = parseJson(str + newline)
        t.equal(res[kNewline], expect, 'got expected newline')
        t.equal(res[kIndent], '  ', 'got expected default indentation')
        t.end()
      })
    }
  }
  t.end()
})

t.test('parses JSON if it is a Buffer, removing BOM bytes', (t) => {
  const str = JSON.stringify({
    foo: 1,
    bar: {
      baz: [1, 2, 3, 'four'],
    },
  })
  const data = Buffer.from(str)
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), data])
  t.same(parseJson(data), JSON.parse(str))
  t.same(parseJson(bom), JSON.parse(str), 'strips the byte order marker')
  t.end()
})

t.test('better errors when faced with \\b and other malarky', (t) => {
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
    t,
    bombom,
    {
      message: /Unexpected token "." \(0xFEFF\)/,
    },
    'only strips a single BOM, not multiple'
  )

  jsonThrows(t, str + '\b\b\b\b\b\b\b\b\b\b\b\b', {
    message: expectMessage(
      'Unexpected ',
      {
        20: 'non-whitespace character after JSON',
        default: /token "\\b" \(0x08\) in JSON/,
      },
      / at position.*\\b"/
    ),
  })

  t.end()
})

t.test('throws SyntaxError for unexpected token', (t) => {
  const data = 'foo'
  jsonThrows(t, data, {
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
  t.end()
})

t.test('throws SyntaxError for unexpected end of JSON', (t) => {
  const data = '{"foo: bar}'
  jsonThrows(t, data, {
    message: expectMessage(
      {
        20: /Unterminated string in JSON at position \d+/,
        default: /Unexpected end of JSON input/,
      },
      / while parsing "{\\"foo: bar}"/
    ),
    code: 'EJSONPARSE',
    position: getLatestMatchingNode({ 20: 11, default: 10 }),
    name: 'JSONParseError',
    systemError: SyntaxError,
  })
  t.end()
})

t.test('throws SyntaxError for unexpected number', (t) => {
  const data = '[[1,2],{3,3,3,3,3}]'
  jsonThrows(t, data, {
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
  t.end()
})

t.test('SyntaxError with less context (limited start)', (t) => {
  const data = '{"6543210'
  jsonThrows(t, data, 3, {
    message: expectMessage(
      {
        20: 'Unterminated string in JSON at position 9',
        default: 'Unexpected end of JSON input',
      },
      ' while parsing near "...',
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
  t.end()
})

t.test('SyntaxError with less context (limited end)', (t) => {
  const data = 'abcde'
  jsonThrows(t, data, 2, {
    message: expectMessage(
      /Unexpected token "a" \(0x61\)/,
      {
        20: ', "abcde" is not valid JSON',
        default: ' in JSON at position 0',
      },
      ' while parsing ',
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
  t.end()
})

t.test('throws for end of input', (t) => {
  const data = '{"a":1,""'
  jsonThrows(t, data, 2, {
    message: expectMessage('Unexpected end of JSON input while parsing'),
    code: 'EJSONPARSE',
    position: 8,
    name: 'JSONParseError',
    systemError: SyntaxError,
  })
  t.end()
})

t[currentNodeMajor >= 20 ? 'test' : 'skip']('coverage on node 20', (t) => {
  t.match(
    new parseJson.JSONParseError(
      { message: `Unexpected token \b at position 2` },
      'a'.repeat(4),
      1
    ).message,
    /Unexpected token/
  )
  t.end()
})

t.test('throws TypeError for undefined', (t) => {
  jsonThrows(t, undefined, new TypeError('Cannot parse undefined'))
  t.end()
})

t.test('throws TypeError for non-strings', (t) => {
  jsonThrows(t, new Map(), new TypeError('Cannot parse [object Map]'))
  t.end()
})

t.test('throws TypeError for empty arrays', (t) => {
  jsonThrows(t, [], new TypeError('Cannot parse an empty array'))
  t.end()
})

t.test('handles empty string helpfully', (t) => {
  jsonThrows(t, '', {
    message: 'Unexpected end of JSON input while parsing empty string',
    name: 'JSONParseError',
    position: 0,
    code: 'EJSONPARSE',
    systemError: SyntaxError,
  })
  t.end()
})

t.test('json parse error class', (t) => {
  t.type(parseJson.JSONParseError, 'function')

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
  t.equal(err1.systemError, poop, 'gets the original error attached')
  t.equal(err1.position, 0)
  t.equal(err1.message, `poop while parsing 'this is some json'`)
  t.equal(err1.name, 'JSONParseError')
  err1.name = 'something else'
  t.equal(err1.name, 'JSONParseError')
  t.notMatch(err1.stack, /fooShouldNotShowUpInStackTrace/)

  // calling it directly, tho, it does
  const fooShouldShowUpInStackTrace = () => {
    return new parseJson.JSONParseError(poop, 'this is some json')
  }
  const err2 = fooShouldShowUpInStackTrace()
  t.equal(err2.systemError, poop, 'gets the original error attached')
  t.equal(err2.position, 0)
  t.equal(err2.message, `poop while parsing 'this is some json'`)
  t.match(err2.stack, /fooShouldShowUpInStackTrace/)

  t.end()
})

t.test('parse without exception', (t) => {
  const bad = 'this is not json'
  t.equal(parseJson.noExceptions(bad), undefined, 'does not throw')
  const obj = { this: 'is json' }
  const good = JSON.stringify(obj)
  t.same(parseJson.noExceptions(good), obj, 'parses json string')
  const buf = Buffer.from(good)
  t.same(parseJson.noExceptions(buf), obj, 'parses json buffer')
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf])
  t.same(parseJson.noExceptions(bom), obj, 'parses json buffer with bom')
  t.end()
})
