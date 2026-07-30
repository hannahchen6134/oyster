// 今日照護看板引擎測試（純函式）：待辦（任務＋餵藥時段）、已完成（含誰）、異常。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTodayBoard, buildHandoff } from '../src/summary.js';

const DATE = '2026-07-30';
const petWithSlots = (slots) => ({ goalMedSlots: JSON.stringify(slots) });
const medLog = (slot, status, by, time = '08:00') => ({
  category: 'med', medSlot: slot, medStatus: status, recordedBy: by,
  eventDateTime: `${DATE} ${time}`, isDeleted: 0
});

test('空狀態：三塊都空', () => {
  const b = computeTodayBoard({ pet: {}, tasks: [], logs: [], date: DATE });
  assert.equal(b.pending.length, 0);
  assert.equal(b.completed.length, 0);
  assert.equal(b.abnormal.length, 0);
});

test('餵藥時段全部待辦（尚未餵）', () => {
  const b = computeTodayBoard({ pet: petWithSlots(['早', '晚']), tasks: [], logs: [], date: DATE });
  const slots = b.pending.filter((p) => p.kind === 'medSlot').map((p) => p.medSlot);
  assert.deepEqual(slots, ['早', '晚']);
});

test('餵過的時段從待辦扣掉，並出現在已完成（含誰）', () => {
  const logs = [medLog('早', '已吃', 'u2', '08:05')];
  const b = computeTodayBoard({ pet: petWithSlots(['早', '晚']), tasks: [], logs, date: DATE });
  const pendingSlots = b.pending.filter((p) => p.kind === 'medSlot').map((p) => p.medSlot);
  assert.deepEqual(pendingSlots, ['晚'], '早已餵→只剩晚待辦');
  const doneMed = b.completed.find((c) => c.kind === 'med' && c.medSlot === '早');
  assert.ok(doneMed, '早應在已完成');
  assert.equal(doneMed.by, 'u2');
  assert.equal(doneMed.at, '08:05');
});

test('待辦任務出現在待辦；完成任務出現在已完成（含誰、幾點）', () => {
  const tasks = [
    { taskId: 't1', status: 'pending', taskType: 'water', title: '再餵水 20ml', scheduledAt: `${DATE} 18:00` },
    { taskId: 't2', status: 'completed', title: '量體重', completedBy: 'u1', completedAt: `${DATE} 09:12` }
  ];
  const b = computeTodayBoard({ pet: {}, tasks, logs: [], date: DATE });
  const p = b.pending.find((x) => x.kind === 'task' && x.taskId === 't1');
  assert.ok(p);
  assert.equal(p.title, '再餵水 20ml');
  const c = b.completed.find((x) => x.kind === 'task' && x.taskId === 't2');
  assert.ok(c);
  assert.equal(c.by, 'u1');
  assert.equal(c.at, '09:12');
});

test('異常：嘔吐與漏藥（medStatus 非「已吃」）都被標出', () => {
  const logs = [
    { category: 'vomit', note: '吐白沫', eventDateTime: `${DATE} 14:00`, isDeleted: 0 },
    medLog('晚', '沒吃', 'u1', '20:00')
  ];
  const b = computeTodayBoard({ pet: petWithSlots(['晚']), tasks: [], logs, date: DATE });
  assert.ok(b.abnormal.find((a) => a.type === 'vomit'));
  assert.ok(b.abnormal.find((a) => a.type === 'medIssue'));
});

test('由任務完成而生的藥事件不會被重複計（只算任務那一筆）', () => {
  const tasks = [{ taskId: 't1', status: 'completed', taskType: 'medication', title: '保肝藥', completedBy: 'u2', completedAt: `${DATE} 20:03` }];
  const logs = [{ category: 'med', medSlot: '', medStatus: '已吃', recordedBy: 'u2', sourceTaskId: 't1', eventDateTime: `${DATE} 20:03`, isDeleted: 0 }];
  const b = computeTodayBoard({ pet: {}, tasks, logs, date: DATE });
  const medEntries = b.completed.filter((c) => c.kind === 'med');
  const taskEntries = b.completed.filter((c) => c.kind === 'task');
  assert.equal(medEntries.length, 0, '任務來源的藥事件不另計');
  assert.equal(taskEntries.length, 1);
});

test('軟刪的紀錄不列入看板', () => {
  const logs = [{ category: 'vomit', eventDateTime: `${DATE} 10:00`, isDeleted: 1 }];
  const b = computeTodayBoard({ pet: {}, tasks: [], logs, date: DATE });
  assert.equal(b.abnormal.length, 0);
});

test('buildHandoff：已完成含誰與時間、還沒做為未餵藥時段、狀況列嘔吐', () => {
  const pet = petWithSlots(['早', '晚']);
  const logs = [
    { category: 'med', medSlot: '早', medStatus: '已吃', caregiverName: '玥鳴', eventDateTime: `${DATE} 08:05`, isDeleted: 0 },
    { category: 'weight', amount: 4.27, eventDateTime: `${DATE} 09:12`, isDeleted: 0 },
    { category: 'food', itemName: '主食罐', amount: 40, unit: 'g', caregiverName: '玥鳴', eventDateTime: `${DATE} 08:20`, isDeleted: 0 },
    { category: 'vomit', note: '白沫', eventDateTime: `${DATE} 14:00`, isDeleted: 0 }
  ];
  const h = buildHandoff(pet, logs);
  // 已完成：藥、體重、餵食（依時間排序）
  assert.equal(h.done.length, 3);
  assert.equal(h.done[0].at, '08:05');
  const med = h.done.find((d) => d.title === '早上的藥');
  assert.ok(med); assert.equal(med.who, '玥鳴');
  assert.ok(h.done.find((d) => d.title === '體重 4.3kg' || d.title === '體重 4.27kg' || d.title.startsWith('體重')));
  // 沒設 caregiverName 的體重 → 飼主
  assert.equal(h.done.find((d) => d.title.startsWith('體重')).who, '飼主');
  // 還沒做：晚的藥（早已餵）
  assert.deepEqual(h.pending.map((p) => p.title), ['晚上的藥']);
  // 狀況：嘔吐
  assert.ok(h.status.some((s) => s.includes('吐')));
});

test('buildHandoff：全平穩、藥都餵了 → 還沒做/狀況給空陣列', () => {
  const pet = petWithSlots(['早']);
  const logs = [{ category: 'med', medSlot: '早', medStatus: '已吃', eventDateTime: `${DATE} 08:00`, isDeleted: 0 }];
  const h = buildHandoff(pet, logs);
  assert.equal(h.pending.length, 0);
  assert.equal(h.status.length, 0);
});
