import { useState, useEffect, useMemo } from 'react';
import { getAllTasks, CalendarTask } from '../api/client';

// --- Cron parser: expands a cron field into a set of matching values ---

function expandCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    // Handle */N
    const stepMatch = trimmed.match(/^(?:(\d+)-(\d+)|(\*))\/(\d+)$/);
    if (stepMatch) {
      const start = stepMatch[1] ? parseInt(stepMatch[1]) : min;
      const end = stepMatch[2] ? parseInt(stepMatch[2]) : max;
      const step = parseInt(stepMatch[4]);
      for (let i = start; i <= end; i += step) result.add(i);
      continue;
    }
    // Handle *
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) result.add(i);
      continue;
    }
    // Handle N-M
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      for (let i = start; i <= end; i++) result.add(i);
      continue;
    }
    // Plain number
    const num = parseInt(trimmed);
    if (!isNaN(num)) result.add(num);
  }
  return result;
}

/** Check if a cron expression fires on a given date */
function cronMatchesDate(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const [minF, hourF, domF, monF, dowF] = parts;

  const month = date.getMonth() + 1; // 1-12
  const dom = date.getDate();
  const dow = date.getDay(); // 0=Sun

  const months = expandCronField(monF, 1, 12);
  if (!months.has(month)) return false;

  // DOM and DOW: if both are restricted (not *), either match triggers
  // If only one is restricted, just that one must match
  const domIsWild = domF === '*';
  const dowIsWild = dowF === '*';

  if (domIsWild && dowIsWild) return true;

  const domSet = expandCronField(domF, 1, 31);
  const dowSet = expandCronField(dowF, 0, 7);
  // Normalize: 7 = Sunday = 0
  if (dowSet.has(7)) dowSet.add(0);

  if (!domIsWild && !dowIsWild) {
    return domSet.has(dom) || dowSet.has(dow);
  }
  if (!domIsWild) return domSet.has(dom);
  return dowSet.has(dow);
}

/** Get the display time from a cron expression (HH:MM) */
function cronTime(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 2) return '';
  const mins = expandCronField(parts[0], 0, 59);
  const hours = expandCronField(parts[1], 0, 23);
  const minVal = Math.min(...mins);
  const hourVal = Math.min(...hours);
  return `${String(hourVal).padStart(2, '0')}:${String(minVal).padStart(2, '0')}`;
}

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = 30 + (Math.abs(hash) % 40);
  return `hsl(${hue}, 55%, 58%)`;
}

interface DayTask {
  task: CalendarTask;
  time: string;
}

export default function TaskCalendar({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<CalendarTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewDate, setViewDate] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<number | null>(null);

  useEffect(() => {
    getAllTasks()
      .then(setTasks)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const cronTasks = useMemo(
    () => tasks.filter(t => t.trigger_type === 'cron' && t.enabled && t.cron_expression),
    [tasks]
  );
  const webhookTasks = useMemo(
    () => tasks.filter(t => t.trigger_type === 'webhook'),
    [tasks]
  );

  // Build calendar grid
  const firstDay = new Date(year, month, 1);
  const startDow = firstDay.getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;

  // Map day-of-month -> tasks for that day
  const dayTaskMap = useMemo(() => {
    const map = new Map<number, DayTask[]>();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const hits: DayTask[] = [];
      for (const t of cronTasks) {
        if (cronMatchesDate(t.cron_expression, date)) {
          hits.push({ task: t, time: cronTime(t.cron_expression) });
        }
      }
      if (hits.length > 0) {
        hits.sort((a, b) => a.time.localeCompare(b.time));
        map.set(d, hits);
      }
    }
    return map;
  }, [cronTasks, year, month, daysInMonth]);

  const today = new Date();
  const isToday = (d: number) => d === today.getDate() && month === today.getMonth() && year === today.getFullYear();

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));
  const goToday = () => setViewDate(new Date());

  const monthLabel = viewDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const selectedDayTasks = selectedDay ? dayTaskMap.get(selectedDay) || [] : [];

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-4 md:px-5 py-3 border-b border-nebula-border bg-nebula-surface/50 flex-shrink-0 gap-2">
        <button onClick={onClose} className="text-nebula-muted hover:text-nebula-text transition-colors flex-shrink-0" title="Back">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div className="flex-1 flex items-center justify-center gap-2">
          <button onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-nebula-hover text-nebula-muted hover:text-nebula-text transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <button onClick={goToday} className="px-2 md:px-3 py-1 text-xs font-medium text-nebula-muted hover:text-nebula-text bg-nebula-bg border border-nebula-border rounded-lg hover:border-nebula-border-light transition-colors">
            Today
          </button>
          <span className="text-sm font-medium text-nebula-text min-w-[120px] md:min-w-[160px] text-center">{monthLabel}</span>
          <button onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-nebula-hover text-nebula-muted hover:text-nebula-text transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
        <span className="text-xs text-nebula-muted hidden md:block flex-shrink-0">
          {cronTasks.length} scheduled{webhookTasks.length > 0 && ` / ${webhookTasks.length} webhook`}
        </span>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-nebula-muted text-sm">Loading tasks...</div>
      ) : (
        <div className="flex-1 flex flex-col md:flex-row overflow-hidden relative">
          {/* Calendar grid */}
          <div className="flex-1 flex flex-col overflow-hidden p-2 md:p-4">
            {/* Day-of-week header */}
            <div className="grid grid-cols-7 mb-1">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <div key={d} className="text-[10px] md:text-[11px] text-nebula-muted font-medium text-center py-1">{d}</div>
              ))}
            </div>

            {/* Day cells */}
            <div className="grid grid-cols-7 flex-1 border-l border-t border-nebula-border">
              {Array.from({ length: totalCells }, (_, i) => {
                const dayNum = i - startDow + 1;
                const inMonth = dayNum >= 1 && dayNum <= daysInMonth;
                const dayTasks = inMonth ? dayTaskMap.get(dayNum) || [] : [];
                const isSelected = selectedDay === dayNum && inMonth;
                const isTodayCell = inMonth && isToday(dayNum);
                const hasTasks = dayTasks.length > 0;

                return (
                  <div
                    key={i}
                    onClick={() => inMonth && setSelectedDay(dayNum === selectedDay ? null : dayNum)}
                    className={`border-r border-b border-nebula-border p-0.5 md:p-1 min-h-[48px] md:min-h-[80px] cursor-pointer transition-colors ${
                      inMonth ? 'hover:bg-nebula-hover' : 'bg-nebula-bg/30'
                    } ${isSelected ? 'bg-nebula-accent-glow' : ''}`}
                  >
                    {inMonth && (
                      <>
                        <div className={`text-[10px] md:text-[11px] mb-0.5 leading-none ${
                          isTodayCell
                            ? 'inline-flex items-center justify-center w-5 h-5 rounded-full bg-nebula-accent text-nebula-bg font-bold'
                            : 'text-nebula-muted'
                        }`}>
                          {dayNum}
                        </div>
                        {/* Mobile: show dot indicators only */}
                        {hasTasks && (
                          <div className="flex gap-0.5 flex-wrap md:hidden px-0.5">
                            {dayTasks.slice(0, 6).map((dt, j) => (
                              <div key={`${dt.task.id}-${j}`} className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: agentColor(dt.task.agent_name) }} title={dt.task.name} />
                            ))}
                          </div>
                        )}
                        {/* Desktop: show task names */}
                        <div className="space-y-px overflow-hidden hidden md:block">
                          {dayTasks.slice(0, 4).map((dt, j) => (
                            <div
                              key={`${dt.task.id}-${j}`}
                              className="flex items-center gap-1 rounded px-1 py-px text-[10px] leading-tight truncate"
                              style={{ backgroundColor: agentColor(dt.task.agent_name) + '18' }}
                              title={`${dt.time} ${dt.task.agent_emoji} ${dt.task.agent_name}: ${dt.task.name}`}
                            >
                              <span className="flex-shrink-0 text-[10px]">{dt.task.agent_emoji}</span>
                              <span className="truncate" style={{ color: agentColor(dt.task.agent_name) }}>
                                {dt.task.name}
                              </span>
                            </div>
                          ))}
                          {dayTasks.length > 4 && (
                            <div className="text-[9px] text-nebula-muted px-1">+{dayTasks.length - 4} more</div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Side panel — desktop: fixed sidebar, mobile: slide-up overlay */}
          {/* Mobile overlay backdrop */}
          {selectedDay && (
            <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => setSelectedDay(null)} />
          )}
          <div className={`
            md:w-[300px] md:border-l md:border-nebula-border md:relative md:flex md:flex-col md:overflow-hidden md:flex-shrink-0
            ${selectedDay ? 'fixed bottom-0 left-0 right-0 z-40 max-h-[60vh] rounded-t-xl' : 'hidden md:flex'}
            bg-nebula-surface md:bg-nebula-surface/30 flex flex-col overflow-hidden
          `}>
            {/* Mobile drag handle */}
            <div className="flex justify-center py-2 md:hidden">
              <div className="w-8 h-1 rounded-full bg-nebula-border" />
            </div>
            <div className="px-4 pb-3 md:p-4 border-b border-nebula-border flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-nebula-text">
                  {selectedDay
                    ? new Date(year, month, selectedDay).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
                    : 'Select a day'}
                </h3>
                {selectedDay && (
                  <p className="text-[11px] text-nebula-muted mt-0.5">
                    {selectedDayTasks.length} task{selectedDayTasks.length !== 1 ? 's' : ''} scheduled
                  </p>
                )}
              </div>
              {selectedDay && (
                <button onClick={() => setSelectedDay(null)} className="md:hidden p-1 text-nebula-muted hover:text-nebula-text">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {!selectedDay && (
                <p className="text-xs text-nebula-muted py-8 text-center">Click a day to see task details</p>
              )}

              {selectedDayTasks.map((dt, i) => (
                <div key={`${dt.task.id}-${i}`} className="bg-nebula-bg border border-nebula-border rounded-lg p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-base">{dt.task.agent_emoji}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-nebula-text truncate">{dt.task.name}</p>
                      <p className="text-[11px] truncate" style={{ color: agentColor(dt.task.agent_name) }}>
                        {dt.task.agent_name}
                      </p>
                    </div>
                    <span className="text-[11px] font-mono text-nebula-accent flex-shrink-0">{dt.time}</span>
                  </div>
                  <p className="text-[11px] text-nebula-muted line-clamp-3 leading-relaxed">{dt.task.prompt}</p>
                  <div className="flex items-center gap-3 mt-2 text-[10px] text-nebula-muted">
                    <span className="font-mono">{dt.task.cron_expression}</span>
                    {dt.task.last_status && (
                      <span className={dt.task.last_status === 'success' ? 'text-green-400' : 'text-red-400'}>
                        {dt.task.last_status}
                      </span>
                    )}
                    {dt.task.last_run_at && (
                      <span>Last: {new Date(dt.task.last_run_at).toLocaleDateString()}</span>
                    )}
                  </div>
                </div>
              ))}

              {/* Webhook tasks section (not day-specific) */}
              {!selectedDay && webhookTasks.length > 0 && (
                <div className="pt-4 border-t border-nebula-border">
                  <h4 className="text-xs font-medium text-nebula-muted mb-2">Webhook Triggers</h4>
                  {webhookTasks.map(t => (
                    <div key={t.id} className="bg-nebula-bg border border-nebula-border rounded-lg p-3 mb-2">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-base">{t.agent_emoji}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-nebula-text truncate">{t.name}</p>
                          <p className="text-[11px] truncate" style={{ color: agentColor(t.agent_name) }}>{t.agent_name}</p>
                        </div>
                        <span className="text-[10px] px-1.5 py-0.5 bg-nebula-surface-2 border border-nebula-border rounded text-nebula-muted">webhook</span>
                      </div>
                      <p className="text-[11px] text-nebula-muted line-clamp-2">{t.prompt}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
