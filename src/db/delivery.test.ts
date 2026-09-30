import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDeliveryText } from './delivery.js';

test('parseDeliveryText reads a charge and a free-delivery threshold', () => {
  const faq = 'What are the delivery charges for orders? SAPPHIRE offers free shipping nationwide for orders worth Rs. 8,000 and above. '
    + 'A shipping cost of Rs. 249 will be charged for any order value under Rs. 8,000.';
  assert.deepEqual(parseDeliveryText(faq), { amount: 24900, freeOver: 800000 });
  assert.deepEqual(parseDeliveryText('A flat delivery charge of Rs 250 applies.'), { amount: 25000, freeOver: null });
  assert.throws(() => parseDeliveryText('We deliver nationwide.'));
});
