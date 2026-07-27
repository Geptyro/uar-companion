import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowPlacement, WINDOW } from '../src/main/config.ts';

const laptop = { x: 0, y: 0, width: 1920, height: 1050 };
/** a second screen to the left, as `screen` reports it: negative x */
const left = { x: -1920, y: 0, width: 1920, height: 1080 };

test('no saved bounds: default size, no position', () => {
	const p = windowPlacement(undefined, [laptop]);
	assert.equal(p.width, WINDOW.width);
	assert.equal(p.height, WINDOW.height);
	assert.equal(p.x, undefined);
	assert.equal(p.y, undefined);
	assert.equal(p.maximized, false);
});

test('saved bounds on a screen that is still there are reused', () => {
	const p = windowPlacement({ width: 1400, height: 900, x: 200, y: 120 }, [laptop]);
	assert.deepEqual(p, { width: 1400, height: 900, x: 200, y: 120, maximized: false });
});

test('position from a monitor that is gone is dropped, size is kept', () => {
	const p = windowPlacement({ width: 1000, height: 700, x: -1500, y: 200 }, [laptop]);
	assert.equal(p.width, 1000);
	assert.equal(p.height, 700);
	assert.equal(p.x, undefined);
	assert.equal(p.y, undefined);
});

test('that same position is fine while the monitor is still connected', () => {
	const p = windowPlacement({ width: 1000, height: 700, x: -1500, y: 200 }, [laptop, left]);
	assert.equal(p.x, -1500);
});

test('a window barely peeking onto a screen counts as unreachable', () => {
	const p = windowPlacement({ width: 900, height: 660, x: 1900, y: 300 }, [laptop]);
	assert.equal(p.x, undefined);
});

test('size is clamped to the floor and to the largest screen', () => {
	const tiny = windowPlacement({ width: 300, height: 200 }, [laptop]);
	assert.equal(tiny.width, WINDOW.minWidth);
	assert.equal(tiny.height, WINDOW.minHeight);

	const huge = windowPlacement({ width: 5000, height: 3000 }, [laptop]);
	assert.equal(huge.width, laptop.width);
	assert.equal(huge.height, laptop.height);
});

test('garbage in config.json falls back to the defaults', () => {
	const p = windowPlacement(
		{ width: NaN, height: 'tall', x: null, y: 0 } as unknown as {
			width: number;
			height: number;
		},
		[laptop]
	);
	assert.equal(p.width, WINDOW.width);
	assert.equal(p.height, WINDOW.height);
	assert.equal(p.x, undefined);
});

test('maximized survives, and only when saved as true', () => {
	assert.equal(windowPlacement({ width: 900, height: 660, maximized: true }, [laptop]).maximized, true);
	assert.equal(windowPlacement({ width: 900, height: 660 }, [laptop]).maximized, false);
});
