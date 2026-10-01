import assert from 'node:assert/strict';
import test from 'node:test';
import { unflatten } from './charts.js';

test('unflatten rebuilds a size chart from a flat list', () => {
  const flat = 'SIZE,S,M,L,LENGTH,22.8,23.5,24.5,CHEST,19.3,20.5,21.7,SHOULDER,18.5,19.7,21'.split(',');
  assert.deepEqual(unflatten(flat), [
    ['SIZE', 'S', 'M', 'L'],
    ['LENGTH', '22.8', '23.5', '24.5'],
    ['CHEST', '19.3', '20.5', '21.7'],
    ['SHOULDER', '18.5', '19.7', '21'],
  ]);
  assert.deepEqual(unflatten(['nothing', 'useful']), []);
});
