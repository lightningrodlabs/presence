import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock';

describe('ManualClock', () => {
  it('starts at the given time and advances by the requested amount', () => {
    const clock = new ManualClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(250);
    expect(clock.now()).toBe(1250);
  });

  it('fires a timeout exactly once when its deadline is crossed', () => {
    const clock = new ManualClock();
    let fired = 0;
    clock.setTimeout(() => {
      fired += 1;
    }, 100);
    clock.advance(99);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
    clock.advance(1000);
    expect(fired).toBe(1);
  });

  it('does not fire a cleared timeout (negative control)', () => {
    const clock = new ManualClock();
    let fired = 0;
    const id = clock.setTimeout(() => {
      fired += 1;
    }, 100);
    clock.clearTimeout(id);
    clock.advance(1000);
    expect(fired).toBe(0);
  });

  it('fires an interval repeatedly, once per period', () => {
    const clock = new ManualClock();
    const times: number[] = [];
    clock.setInterval(() => times.push(clock.now()), 200);
    clock.advance(650);
    expect(times).toEqual([200, 400, 600]);
  });

  it('stops an interval after clearInterval, including mid-advance re-arms', () => {
    const clock = new ManualClock();
    let fired = 0;
    const id = clock.setInterval(() => {
      fired += 1;
      if (fired === 2) clock.clearInterval(id);
    }, 100);
    clock.advance(1000);
    expect(fired).toBe(2);
  });

  it('runs due timers in deadline order with callbacks seeing their own fire time', () => {
    const clock = new ManualClock();
    const order: Array<[string, number]> = [];
    clock.setTimeout(() => order.push(['b', clock.now()]), 200);
    clock.setTimeout(() => order.push(['a', clock.now()]), 100);
    clock.advance(300);
    expect(order).toEqual([
      ['a', 100],
      ['b', 200],
    ]);
    expect(clock.now()).toBe(300);
  });

  it('breaks deadline ties by creation order', () => {
    const clock = new ManualClock();
    const order: string[] = [];
    clock.setTimeout(() => order.push('first'), 100);
    clock.setTimeout(() => order.push('second'), 100);
    clock.advance(100);
    expect(order).toEqual(['first', 'second']);
  });

  it('fires a timer re-armed during advance() within the same window', () => {
    const clock = new ManualClock();
    const times: number[] = [];
    const arm = () => {
      clock.setTimeout(() => {
        times.push(clock.now());
        if (times.length < 3) arm();
      }, 100);
    };
    arm();
    clock.advance(1000);
    expect(times).toEqual([100, 200, 300]);
  });

  it('treats a negative timeout delay as immediate on the next advance', () => {
    const clock = new ManualClock(500);
    let fired = 0;
    clock.setTimeout(() => {
      fired += 1;
    }, -50);
    clock.advance(0);
    expect(fired).toBe(1);
  });
});
