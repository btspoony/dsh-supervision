/**
 * The colour vocabulary: token styling with colour on, byte-clean identity with
 * it off, and the environment rules that pick between them.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLAIN, colorEnabled, createTheme, markdownTheme, themeFor } from './theme.js';

const ESC = '\x1b';

test('colour is off when asked, redirected or dumb', () => {
  assert.equal(colorEnabled({ noColor: '1', stdoutTTY: true, term: 'xterm' }), false);
  // NO_COLOR present at all disables, even empty.
  assert.equal(colorEnabled({ noColor: '', stdoutTTY: true, term: 'xterm' }), false);
  assert.equal(colorEnabled({ noColor: undefined, stdoutTTY: false, term: 'xterm' }), false);
  assert.equal(colorEnabled({ noColor: undefined, stdoutTTY: true, term: 'dumb' }), false);
  assert.equal(colorEnabled({ noColor: undefined, stdoutTTY: true, term: 'xterm-256color' }), true);
});

test('the plain theme is the identity and emits no escape bytes', () => {
  const theme = createTheme({ color: false });
  assert.equal(theme.color, false);
  const styled = [
    theme.fg('accent', 'x'),
    theme.bg('userBg', 'x'),
    theme.bold('x'),
    theme.dim('x'),
    theme.bar('x'),
  ];
  for (const text of styled) {
    assert.equal(text, 'x');
    assert.equal(text.includes(ESC), false);
  }
});

test('the colour theme uses 256-colour SGR for foreground, background and attributes', () => {
  const theme = createTheme({ color: true });
  assert.equal(theme.color, true);
  assert.match(theme.fg('accent', 'x'), /\x1b\[38;5;39m/);
  assert.match(theme.bg('userBg', 'x'), /\x1b\[48;5;236m/);
  assert.match(theme.bold('x'), /\x1b\[1m/);
  assert.match(theme.dim('x'), /\x1b\[2m/);
  assert.match(theme.bar('x'), /\x1b\[7m/);
  // The background helper never carries the token's foreground or boldness.
  assert.doesNotMatch(theme.bg('accent', 'x'), /38;5|\x1b\[1m/);
});

test('themeFor selects the plain theme for NO_COLOR, a non-TTY or TERM=dumb', () => {
  assert.equal(themeFor({ NO_COLOR: '1', TERM: 'xterm' }, true).color, false);
  assert.equal(themeFor({ TERM: 'xterm' }, false).color, false);
  assert.equal(themeFor({ TERM: 'dumb' }, true).color, false);
  assert.equal(themeFor({ TERM: 'xterm-256color' }, true).color, true);
  assert.equal(themeFor({}, true).color, true, 'no TERM at all still allows colour');
});

test('every markdown role maps onto the token table and degrades to identity', () => {
  const plain = markdownTheme(PLAIN);
  for (const [name, fn] of Object.entries(plain)) {
    if (typeof fn === 'function') assert.equal(fn('x'), 'x', `${name} is identity in plain mode`);
  }
  const color = markdownTheme(createTheme({ color: true }));
  assert.match(color.heading('x'), /\x1b\[1m/, 'a heading is bold');
  assert.match(color.heading('x'), /38;5/);
  assert.match(color.codeBlockBorder('x'), /38;5;240/);
  assert.match(color.listBullet('x'), /38;5;39/);
  assert.match(color.quote('x'), /38;5;245/);
});
