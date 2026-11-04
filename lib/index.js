import z from "@deepseek-ai/schemastery";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/engine/time.ts
const formatters = /* @__PURE__ */ new Map();
function formatterFor(timeZone) {
	let formatter = formatters.get(timeZone);
	if (formatter === void 0) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit"
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
}
/** Whether a string is a valid IANA time-zone name this runtime understands. */
function isValidTimeZone(timeZone) {
	if (timeZone === "UTC") return true;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}
/**
* The local wall clock of `ts` in `timeZone`.
* @param ts - epoch milliseconds.
* @param timeZone - IANA zone; invalid names fall back to UTC.
*/
function localParts(ts, timeZone) {
	const parts = formatterFor(timeZone !== null && timeZone !== void 0 && isValidTimeZone(timeZone) ? timeZone : "UTC").formatToParts(new Date(ts));
	const get = (type) => {
		const found = parts.find((part) => part.type === type);
		return found === void 0 ? 0 : Number.parseInt(found.value, 10);
	};
	const year = get("year");
	const month = get("month");
	const day = get("day");
	return {
		year,
		month,
		day,
		hour: get("hour"),
		minute: get("minute"),
		second: get("second"),
		weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay()
	};
}
function offsetAt(ts, timeZone) {
	const parts = localParts(ts, timeZone);
	return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(ts / 1e3) * 1e3;
}
/**
* Convert a wall-clock time in a zone to an epoch instant.
* @param parts - year, month (1-12), day, optional time fields.
* @param timeZone - IANA zone.
* @returns epoch milliseconds.
*/
function zonedToUtc(parts, timeZone) {
	const zone = timeZone !== null && timeZone !== void 0 && isValidTimeZone(timeZone) ? timeZone : "UTC";
	const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0, parts.ms ?? 0);
	let guess = asUtc - offsetAt(asUtc, zone);
	guess = asUtc - offsetAt(guess, zone);
	return guess;
}
/** `YYYY-MM-DD` in the given zone, used as the diary day key. */
function dayKey(ts, timeZone) {
	const parts = localParts(ts, timeZone);
	return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
/** `YYYY-MM-DD HH:mm` in the given zone. */
function formatDateTime(ts, timeZone) {
	const parts = localParts(ts, timeZone);
	return `${dayKey(ts, timeZone)} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}
/**
* The instant at which the local day containing `ts` ends.
* @param ts - any instant in the day.
* @param timeZone - the conversation's zone.
*/
function endOfLocalDay(ts, timeZone) {
	const parts = localParts(ts, timeZone);
	return zonedToUtc({
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour: 23,
		minute: 59,
		second: 59,
		ms: 999
	}, timeZone);
}
const DAY_MS$2 = 864e5;
/** Add whole days to an instant, keeping the local time of day across DST changes. */
function addDays(ts, days, timeZone) {
	const parts = localParts(ts, timeZone);
	return zonedToUtc({
		year: parts.year,
		month: parts.month,
		day: parts.day + days,
		hour: parts.hour,
		minute: parts.minute,
		second: parts.second
	}, timeZone);
}
const CN_NUMERALS = {
	一: 1,
	二: 2,
	两: 2,
	三: 3,
	四: 4,
	五: 5,
	六: 6,
	七: 7,
	八: 8,
	九: 9,
	十: 10,
	十一: 11,
	十二: 12,
	十三: 13,
	十四: 14,
	十五: 15,
	二十: 20,
	三十: 30
};
function numberFrom(raw) {
	if (raw === void 0) return void 0;
	if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
	if (CN_NUMERALS[raw] !== void 0) return CN_NUMERALS[raw];
	/*
	* Composed forms: 二十三 (23), 三十一 (31), 十 (10). The lookup table only
	* covers the small ones people use for durations; dates go further, and
	* "十二月二十号" is how a date is actually said out loud.
	*/
	const composed = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(raw);
	if (composed === null) return void 0;
	return (composed[1] === void 0 ? 1 : CN_NUMERALS[composed[1]]) * 10 + (composed[2] === void 0 ? 0 : CN_NUMERALS[composed[2]]);
}
/** ISO weekday of a date: Monday = 1 … Sunday = 7. */
function isoWeekday(parts) {
	return parts.weekday === 0 ? 7 : parts.weekday;
}
const CN_WEEKDAY = {
	一: 1,
	二: 2,
	三: 3,
	四: 4,
	五: 5,
	六: 6,
	日: 7,
	天: 7
};
const EN_WEEKDAY = {
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6,
	sunday: 7
};
/**
* The instant at which the local day containing `ts` begins.
* @param ts - any instant in the day.
* @param timeZone - the conversation's zone.
*/
function startOfLocalDay(ts, timeZone) {
	const parts = localParts(ts, timeZone);
	return zonedToUtc({
		year: parts.year,
		month: parts.month,
		day: parts.day,
		hour: 0,
		minute: 0,
		second: 0,
		ms: 0
	}, timeZone);
}
/** One whole local day as an interval. */
function dayWindow(ts, timeZone) {
	return {
		from: startOfLocalDay(ts, timeZone),
		to: endOfLocalDay(ts, timeZone)
	};
}
/**
* Resolve a time phrase into the interval it names — no judgement about whether
* that interval is still ahead. `parseDue` (below) is the entry point callers
* want; this half exists so "does the sentence name a time at all" can be asked
* separately from "is that time still to come".
*
* Every deadline is stored as a window, not a point, because "下周一" and
* "下周" are the same promise at two precisions: one day, or seven. Collapsing
* both into a single `expires_at` throws away the only part a model can act
* on — whether to answer "明天" or "这周内" back to the user.
*
* `precision` exists so the block can hedge. A `fuzzy` window is a guess and
* renders with 约; a `day` is not and does not. `phrase` is the original
* wording, kept so a later turn can tell "他们把时间说清了" from "他们改主意了".
*
* Resolution is deliberately arithmetic, not model work: a language model asked
* to turn "下周三" into a date is being asked to do calendar math in its head,
* and quietly getting it wrong is the default outcome. The model's job is to
* copy the phrase out verbatim (see `extractPrompt`); deciding what the phrase
* means is this function's job.
*
* Forms understood, in the order they are tried (specific before vague):
*   2026-11-09 / 2026/11/9 / 2026年11月9日 / 11月9号 / 十二月二十号
*   下下周末 · 下周末 · 本周末 · 下下周五 · 下周五 · 这周五 · 周五/周天/星期天
*   三天后 · 两周后 · 三个月后 · 三天内 · in 3 days · next friday
*   大后天 · 后天 · 明天/明晚 · 今天/今晚
*   下周 · 下下周 · 这周 · next week
*   下个月五号 · 这个月五号 · 下下个月 · 下个月 · 这个月/月底 · next month
*   过几天 · 过几周 · 过几个月（fuzzy，带 约）
* Deliberately not forms: 昨天/前天/上周五 — history, see `parseDue`. 过段时间 /
* 以后 / 改天 — too vague to date without inventing one.
*
* @param text - the sentence that may carry a deadline.
* @param baseTs - when the sentence was said; every relative phrase resolves against it.
* @param timeZone - the conversation's zone.
* @returns the window, or undefined when the sentence names none.
*/
function resolveDue(text, baseTs, timeZone) {
	const lower = text.toLowerCase();
	const base = localParts(baseTs, timeZone);
	const weekdayOf = (ts) => isoWeekday(localParts(ts, timeZone));
	const endOfMonth = (year, month) => zonedToUtc({
		year,
		month: month + 1,
		day: 1
	}, timeZone) - 1;
	const dayOf = (offsetDays, phrase, precision = "day") => ({
		kind: "relative",
		...dayWindow(addDays(baseTs, offsetDays, timeZone), timeZone),
		precision,
		phrase
	});
	const explicit = /(?<!\d)(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})[日号]?/u.exec(text);
	if (explicit !== null) {
		const year = Number(explicit[1]);
		const month = Number(explicit[2]);
		const day = Number(explicit[3]);
		if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return {
			kind: "absolute",
			...dayWindow(zonedToUtc({
				year,
				month,
				day
			}, timeZone), timeZone),
			precision: "day",
			phrase: explicit[0]
		};
	}
	// "十二月二十号" is how a date is said out loud; digits are how it is typed.
	const monthDay = /(?<!\d)(\d{1,2}|[一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九十])月(\d{1,2}|[一二三四五六七八九]?十[一二三四五六七八九]?|[一二三四五六七八九十])[日号]/u.exec(text);
	if (monthDay !== null) {
		const month = numberFrom(monthDay[1]);
		const day = numberFrom(monthDay[2]);
		if (month !== void 0 && day !== void 0 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
			let year = base.year;
			/*
			* A bare "1月5日" said in December means next year's, so a date that
			* lands in the past gets bumped a year — but only when it is most of a
			* year back, which is the year-end case. "10月15日" said in November is
			* last month, and bumping it would invent a deadline eleven months out.
			* The nearer past is left alone and dropped by the guard in parseDue.
			*/
			const asThisYear = zonedToUtc({
				year,
				month,
				day
			}, timeZone);
			if (asThisYear < startOfLocalDay(baseTs, timeZone) && startOfLocalDay(baseTs, timeZone) - asThisYear > 300 * 864e5) year += 1;
			return {
				kind: "absolute",
				...dayWindow(zonedToUtc({
					year,
					month,
					day
				}, timeZone), timeZone),
				precision: "day",
				phrase: monthDay[0]
			};
		}
	}
	const iso = /(?<!\d)(20\d{2})-(\d{2})-(\d{2})(?!\d)/u.exec(text);
	if (iso !== null) return {
		kind: "absolute",
		...dayWindow(zonedToUtc({
			year: Number(iso[1]),
			month: Number(iso[2]),
			day: Number(iso[3])
		}, timeZone), timeZone),
		precision: "day",
		phrase: iso[0]
	};
	/*
	* Weekday names inside a named week. "下周一" resolves to a date, not to a
	* week: the user picked the day, so hedging with a seven-day window would be
	* throwing away precision they gave us for free.
	*/
	/*
	* Weekends are checked before weeks: 「下周末」 opens with a perfectly valid
	* 「下周」 and would otherwise be read as the whole seven days.
	*/
	const cnWeekend = /(?<![上])(下下|下)?(?:个)?(?:周|星期|礼拜)末/u.exec(text);
	if (cnWeekend !== null) {
		const ahead = cnWeekend[1] === "下下" ? 14 : cnWeekend[1] === "下" ? 7 : 0;
		const saturday = addDays(baseTs, 6 - weekdayOf(baseTs) + ahead, timeZone);
		return {
			kind: "relative",
			from: startOfLocalDay(saturday, timeZone),
			to: endOfLocalDay(addDays(saturday, 1, timeZone), timeZone),
			precision: "day",
			phrase: cnWeekend[0]
		};
	}
	/*
	* Double prefixes before single ones: 「下下周五」 contains 「下周五」, and
	* matching the shorter form first returns a date a week early — a plausible
	* answer to the wrong question, which is the worst kind.
	*/
	const cnDoubleNextWeekday = /下下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/u.exec(text);
	if (cnDoubleNextWeekday !== null) {
		const target = CN_WEEKDAY[cnDoubleNextWeekday[1]];
		if (target !== void 0) return dayOf(14 - weekdayOf(baseTs) + target, cnDoubleNextWeekday[0]);
	}
	const cnNextWeekday = /下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/u.exec(text);
	if (cnNextWeekday !== null) {
		const target = CN_WEEKDAY[cnNextWeekday[1]];
		if (target !== void 0) return dayOf(8 - weekdayOf(baseTs) + target - 1, cnNextWeekday[0]);
	}
	const cnThisWeekday = /这(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/u.exec(text);
	if (cnThisWeekday !== null) {
		const target = CN_WEEKDAY[cnThisWeekday[1]];
		if (target !== void 0) return dayOf(1 - weekdayOf(baseTs) + target - 1, cnThisWeekday[0]);
	}
	/*
	* A bare weekday — 周天, 周日, 星期天 — with no 这 or 下 in front means the
	* next one to arrive, today included: that is what people mean when they
	* say it. 上周五 is excluded on purpose. It is history, and a window that
	* has already closed is not a deadline (see the guard in parseDue).
	*
	* Recurring forms are excluded too: 「每周一」 names a habit, and turning it
	* into one date would report the habit as overdue from that day on.
	*/
	const recurring = /每(?:天|日|个?(?:周|星期|礼拜|月|年))/u.test(text);
	const cnBareWeekday = /(?<![下这上])(?:周|星期|礼拜)([一二三四五六日天])(?![到至~～-])/u.exec(text);
	if (!recurring && cnBareWeekday !== null) {
		const target = CN_WEEKDAY[cnBareWeekday[1]];
		if (target !== void 0) return dayOf((target - weekdayOf(baseTs) + 7) % 7, cnBareWeekday[0]);
	}

	const enNextWeekday = /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.exec(lower);
	if (enNextWeekday !== null) {
		const target = EN_WEEKDAY[enNextWeekday[1].toLowerCase()];
		if (target !== void 0) return dayOf(8 - weekdayOf(baseTs) + target - 1, enNextWeekday[0]);
	}
	const relative = /(\d+|[一二两三四五六七八九十]+)\s*(天|日|周|星期|个月|月|小时|年)(?:之?后|以后|后)/u.exec(text);
	if (relative !== null) {
		const amount = numberFrom(relative[1]);
		if (amount !== void 0) {
			const unit = relative[2];
			if (unit === "小时") return dayOf(amount / 24, relative[0]);
			if (unit === "年") return dayOf(amount * 365, relative[0]);
			if (unit === "月" || unit === "个月") return dayOf(amount * 30, relative[0]);
			return dayOf(unit === "天" || unit === "日" ? amount : amount * 7, relative[0]);
		}
	}
	/*
	* "三天内" is a window, not a point: it says the thing happens somewhere
	* between now and then, and that "somewhere in between" is what the user
	* would confirm against if asked.
	*/
	const within = /(\d+|[一二两三四五六七八九十]+)\s*(天|日|周|星期|个月|月)\s*(?:之?内|以内)/u.exec(text);
	if (within !== null) {
		const amount = numberFrom(within[1]);
		if (amount !== void 0) {
			const unit = within[2];
			const span = unit === "天" || unit === "日" ? amount : unit === "周" || unit === "星期" ? amount * 7 : amount * 30;
			return {
				kind: "relative",
				from: startOfLocalDay(baseTs, timeZone),
				to: endOfLocalDay(addDays(baseTs, span, timeZone), timeZone),
				precision: "fuzzy",
				phrase: within[0]
			};
		}
	}
	const enRelative = /\bin\s+(\d+)\s+(hour|day|week|month|year)s?\b/iu.exec(lower);
	if (enRelative !== null) {
		const amount = Number(enRelative[1]);
		const unit = enRelative[2].toLowerCase();
		const phrase = enRelative[0];
		if (unit === "hour") return dayOf(amount / 24, phrase);
		return dayOf(unit === "day" ? amount : unit === "week" ? amount * 7 : unit === "month" ? amount * 30 : amount * 365, phrase);
	}
	for (const [pattern, offset] of [
		[/大后天/u, 3],
		[/后天/u, 2],
		[/明晚|明早|明儿/u, 1],
		[/明天|明日|tomorrow/iu, 1],
		[/今天|今日|今晚|tonight|today/iu, 0]
	]) if (pattern.test(text)) return dayOf(offset, pattern.source);
	/*
	* A named week spans Monday to Sunday. The window matters: "下周我要搬家"
	* answered as a single date would put a seven-day promise on one day, and
	* then report it as overdue on day two.
	*/
	const nextMonday = addDays(baseTs, 8 - weekdayOf(baseTs), timeZone);
	if (/下下(?:个)?(?:周|星期|礼拜)/u.test(text)) return {
		kind: "relative",
		from: startOfLocalDay(addDays(nextMonday, 7, timeZone), timeZone),
		to: endOfLocalDay(addDays(nextMonday, 13, timeZone), timeZone),
		precision: "week",
		phrase: text.match(/下下(?:个)?(?:周|星期|礼拜)/u)[0]
	};
	if (/下(?:个)?(?:周|星期|礼拜)|next week/iu.test(lower)) return {
		kind: "relative",
		from: startOfLocalDay(nextMonday, timeZone),
		to: endOfLocalDay(addDays(nextMonday, 6, timeZone), timeZone),
		precision: "week",
		phrase: /next week/iu.test(lower) ? "next week" : text.match(/下(?:个)?(?:周|星期|礼拜)/u)[0]
	};
	if (/这(?:个)?(?:周|星期|礼拜)|本(?:周|星期)|this week/iu.test(lower)) return {
		kind: "relative",
		from: startOfLocalDay(baseTs, timeZone),
		to: endOfLocalDay(addDays(baseTs, 7 - weekdayOf(baseTs), timeZone), timeZone),
		precision: "week",
		phrase: /this week/iu.test(lower) ? "this week" : "这周"
	};
	/*
	* A day inside a named month — 「下个月五号」 — is the most precise deadline
	* people actually give. Read as a whole month it is still defensible and
	* still useless: the block would say 下个月 rather than the fifth, and the
	* reminder would arrive four weeks early.
	*/
	const namedMonthDay = /(下下(?:个)?月|下(?:个)?月|这个?月|本月)(\d{1,2}|[一二三四五六七八九十]{1,3})[日号]/u.exec(text);
	if (namedMonthDay !== null) {
		const day = numberFrom(namedMonthDay[2]);
		const shift = namedMonthDay[1].startsWith("下下") ? 2 : namedMonthDay[1].startsWith("下") ? 1 : 0;
		const index = base.month - 1 + shift;
		const year = base.year + Math.floor(index / 12);
		const month = index % 12 + 1;
		if (day !== void 0 && day >= 1) {
			const at = zonedToUtc({
				year,
				month,
				day
			}, timeZone);
			const landed = localParts(at, timeZone);
			// "2月30号" is not a date; rolling into March would invent one.
			if (landed.year === year && landed.month === month && landed.day === day) return {
				kind: "relative",
				...dayWindow(at, timeZone),
				precision: "day",
				phrase: namedMonthDay[0]
			};
		}
	}
	const nextMonth = base.month === 12 ? {
		year: base.year + 1,
		month: 1
	} : {
		year: base.year,
		month: base.month + 1
	};
	if (/下下(?:个)?月/u.test(lower)) return {
		kind: "relative",
		from: zonedToUtc({
			year: nextMonth.month === 12 ? nextMonth.year + 1 : nextMonth.year,
			month: nextMonth.month === 12 ? 1 : nextMonth.month + 1,
			day: 1
		}, timeZone),
		to: endOfMonth(nextMonth.month === 12 ? nextMonth.year + 1 : nextMonth.year, nextMonth.month === 12 ? 1 : nextMonth.month + 1),
		precision: "month",
		phrase: "下下个月"
	};
	if (/下(?:个)?月|next month/iu.test(lower)) return {
		kind: "relative",
		from: zonedToUtc({
			year: nextMonth.year,
			month: nextMonth.month,
			day: 1
		}, timeZone),
		to: endOfMonth(nextMonth.year, nextMonth.month),
		precision: "month",
		phrase: "下个月"
	};
	if (/这个?月|本(?:个)?月|月底|end of (?:the )?month/iu.test(lower)) return {
		kind: "relative",
		from: startOfLocalDay(baseTs, timeZone),
		to: endOfMonth(base.year, base.month),
		precision: "month",
		phrase: "月底"
	};
	/*
	* "过几天" is a real answer, just an imprecise one. The user's own reading is
	* 2–10 days; a single day would be a made-up fact and `null` would throw away
	* something they did tell us, so the window is stored and rendered with 约.
	*/
	if (/过几(?:天|日)|这几(?:天)|这几天|这几日|最近几(?:天|日)/u.test(text)) return {
		kind: "relative",
		from: startOfLocalDay(addDays(baseTs, 2, timeZone), timeZone),
		to: endOfLocalDay(addDays(baseTs, 10, timeZone), timeZone),
		precision: "fuzzy",
		phrase: "过几天"
	};
	if (/过几(?:个)?(?:周|星期|礼拜)/u.test(text)) return {
		kind: "relative",
		from: startOfLocalDay(addDays(baseTs, 7, timeZone), timeZone),
		to: endOfLocalDay(addDays(baseTs, 28, timeZone), timeZone),
		precision: "fuzzy",
		phrase: "过几周"
	};
	if (/过几(?:个)?月/u.test(text)) return {
		kind: "relative",
		from: startOfLocalDay(addDays(baseTs, 30, timeZone), timeZone),
		to: endOfLocalDay(addDays(baseTs, 120, timeZone), timeZone),
		precision: "fuzzy",
		phrase: "过几个月"
	};
}
/**
* The deadline a sentence names, or nothing.
*
* A window that has already closed is history, not a deadline, and it is
* dropped here rather than by every caller. Storing one would make the fact
* read 「截止 11-01 · 已到期」 the instant it is written, and a plan would be
* counted overdue from birth — for a sentence like 「前天我把车卖了」, which
* names no deadline at all. Past references stay where they belong: in the
* text and in `created_at`.
*
* @param text - the sentence that may carry a deadline.
* @param baseTs - when it was said.
* @param timeZone - the conversation's zone.
* @returns the window, or undefined when it names none, or names one already gone.
*/
function parseDue(text, baseTs, timeZone) {
	const hit = resolveDue(text, baseTs, timeZone);
	if (hit === undefined) return void 0;
	if (hit.to < startOfLocalDay(baseTs, timeZone)) return void 0;
	return hit;
}

//#endregion
//#region src/engine/types.ts
/** Resolved defaults, mirroring the decision table; every field is overridable from the plugin config. */
function defaultEngineConfig() {
	return {
		locale: "zh",
		decay: {
			d: 1,
			sInitial: 30,
			sMaxMultiplier: 50,
			floor: .02,
			retrievalBoost: .25,
			expiryHalfLifeDays: 45
		},
		emotion: {
			l1Weight: .5,
			subjectiveWeight: 1,
			boost: .18
		},
		retrieval: {
			budgetTokens: 2e3,
			hardCapTokens: 3e3,
			subjectiveShare: .25,
			maxItems: 20,
			/**
			* How many of the most recent standing preferences ride along on every
			* turn regardless of the query. Zero restores the old query-only behaviour.
			*/
			residentPreferences: 3,
			/**
			* Plans offered on every turn. They do not compete with facts on
			* similarity: a plan the user stated is exactly the thing they will
			* not re-ask about, so lexical recall never brings it back.
			*/
			maxPlans: 3,
			/**
			* Days between two asks about the same overdue plan.
			*
			* The first ask is immediate — a plan is news the moment its date goes
			* by. After that the interval is this, because asking every turn turns
			* a plan zone into a reminder the user learns to skim, and asking once
			* makes silence permanent. Zero or below restores ask-once.
			*/
			planNudgeDays: 2,
			/**
			* The share of the subjective budget the diary keeps for itself, so a
			* long impression cannot crowd it out entirely.
			*/
			diaryShare: .4,
			layerPenalty: {
				fact: 0,
				event: .04,
				subjective: .02,
				l0: .15
			},
			conflictPenalty: .85,
			minScore: .05,
			/**
			* Facts below this confidence that were not written by hand are tagged
			* "unconfirmed" in the memory block.
			*/
			unconfirmedBelow: .6,
			/**
			* Strict match is an implicit AND over every CJK bigram of the sentence:
			* 「记得我不吃香菜吗」 is seven bigrams, and missing one returns nothing.
			* When the strict pass yields fewer than `relaxBelow` facts, a second
			* OR pass runs; its hits are multiplied by `relaxPenalty` so they can
			* never outrank a strict hit, and are dropped when they share less than
			* `relaxMinOverlap` of the query's bigrams (a single common bigram is
			* not a memory).
			*/
			relaxMatch: true,
			relaxBelow: 3,
			relaxPenalty: .55,
			relaxMinOverlap: .25,
			/**
			* Print the tone an event was spoken in, when it was not neutral.
			* Q64: this is the whole feature — the tone rides along with the line
			* instead of a separate injection channel (see design.md §13).
			*/
			toneHint: true
		},
		consolidation: {
			triggerTokens: 2e4,
			idleMinutes: 5,
			maxRunSeconds: 180,
			itemTimeoutSeconds: 30,
			retries: 2,
			dlqItems: 20,
			dlqDays: 7,
			coldStartFacts: 50,
			diaryPerDay: 3,
			narrativeEvidence: 12,
			sampleK: 20,
			sampleM: 100,
			dailyLlmCalls: 200,
			/**
			* How many retrieval aliases the model may hang on one fact — the
			* words the user might search it by next time. Zero turns the
			* feature off and leaves the old prompt untouched.
			*/
			aliasCount: 3
		},
		segmentation: {
			gapMinutes: 30,
			hardTopicJaccard: .12,
			softSalience: .7,
			softDelta: .25,
			microTopicJaccard: .3,
			microSalience: .55,
			minSecondary: 5
		},
		roles: {
			visitorPurgeHours: 48,
			pendingDeleteDays: 7,
			/**
			* Reserved. Nothing reads it: promotion is the master's `approve` call,
			* never a visit counter, because who gets a friend's read access is not a
			* threshold. Kept in the schema so an existing deployment does not fail
			* validation; do not promise it in user-facing text.
			*/
			promotionVisits: 3,
			demotionDays: 5
		},
		backup: {
			enabled: true,
			keep: 7,
			everyHours: 24,
			dir: ""
		},
		privacy: {
			masterCrossIdentity: true,
			crossIdentityRaw: false
		}
	};
}
/** The stable identity id of the owner. */
const MASTER_ID = "master";

//#endregion
//#region src/config.ts
const defaults = defaultEngineConfig();
/** The schemastery schema the harness validates at load time. */
/** Defaults for the hook-index layer (kept beside the config for single sourcing). */
const indexDefaults = {
	hooksBudgetTokens: 300,
	maxHooks: 16,
	minHookScore: .3,
	expandBudgetTokens: 4000,
	maxCharsPerPack: 60000,
	rebuildMinutes: 5,
	coldDays: 7,
	includeAssistant: true
};
/** The prefix every tool name carries unless `toolPrefix` says otherwise. */
const DEFAULT_TOOL_PREFIX = "memory_";
/** A tool name fragment: lowercase start, then name characters only. */
const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,23}$/u;
/**
* The 15 suffixes behind the prefix, in registration order.
*
* Kept as data because three separate things need the same list: the collision
* probe in `apply()` (which names have to be free), the renamer below (which
* words in a prompt are tool names), and the tool registry itself. A hardcoded
* second copy would drift, and the drift would be silent — the prompt would
* keep telling the model to call `memory_search` while the registered tool is
* `loom_search`.
*/
const TOOL_SUFFIXES = [
	"search",
	"write",
	"forget",
	"settle",
	"resolve",
	"profile",
	"persona",
	"identity",
	"expand",
	"pack",
	"index",
	"doctor",
	"demo",
	"handoff",
	"episodes",
	"import"
];
/**
* Definitions this module registered in this process.
*
* The collision guard has to answer "is this name taken by *someone else*".
* Without this set, a second `apply()` in the same process (live reconcile, a
* plugin listed twice) would find its own tool in the registry and report a
* phantom conflict — the one message a user must never see by mistake, because
* it sends them off to uninstall a plugin they do not have.
*/
const OWN_TOOLS = /* @__PURE__ */ new WeakSet();
/**
* Rewrite tool names in a string from the default prefix to the configured one.
*
* Applied at three boundaries rather than at the 21 places the names appear:
* tool definitions (name + description), every prompt section's `text()`, and
* every tool's return value. Those three cover all 21, including the ones
* inside `copy` — and they keep covering any added later.
*
* `memory_edges` (a table) and `memory_loom` (not a name we emit) are not in
* the suffix list, so they pass through untouched.
* @param text - text that may mention tool names.
* @param prefix - the configured prefix.
* @returns the same text with the configured prefix.
*/
function renameToolNames(text, prefix) {
	if (prefix === DEFAULT_TOOL_PREFIX || text.length === 0) return text;
	let out = text;
	for (const suffix of TOOL_SUFFIXES) out = out.replaceAll(`${DEFAULT_TOOL_PREFIX}${suffix}`, `${prefix}${suffix}`);
	return out;
}
const Config$1 = z.object({
	path: z.string().required(),
	ownerName: z.string().default("主人"),
	locale: z.union(["zh", "en"]).default(defaults.locale),
	timezone: z.string().default(""),
	capture: z.boolean().default(true),
	/**
	* Prefix every tool name carries. `memory_` is the ecosystem's de-facto
	* standard, which is exactly why it collides: at least four other memory
	* plugins ship `memory_search` / `memory_write` / `memory_forget`. The host
	* keys tools by name and throws on a duplicate, so a second memory plugin
	* takes the *whole* new plugin down with it.
	*
	* Set this to something private (`loom_`) to run beside another memory
	* plugin. It is off by default on purpose: two memories injected every turn
	* is a different product, not a feature — see design.md §30.
	*/
	toolPrefix: z.string().default("memory_"),
	maintenanceIntervalSeconds: z.natural().min(10).default(60),
	l0: z.object({
		/** Per-message storage cap. `0` stores the message verbatim. */
		maxCharsPerMessage: z.natural().default(0)
	}),
	consolidation: z.object({
		enabled: z.boolean().default(true),
		provider: z.string().default(""),
		model: z.string().default(""),
		triggerTokens: z.natural().default(defaults.consolidation.triggerTokens),
		idleMinutes: z.natural().default(defaults.consolidation.idleMinutes),
		maxRunSeconds: z.natural().min(10).default(defaults.consolidation.maxRunSeconds),
		itemTimeoutSeconds: z.natural().min(5).default(defaults.consolidation.itemTimeoutSeconds),
		dailyLlmCalls: z.natural().default(defaults.consolidation.dailyLlmCalls),
		sampleK: z.natural().min(3).default(defaults.consolidation.sampleK),
		sampleM: z.natural().default(defaults.consolidation.sampleM),
		coldStartFacts: z.natural().default(defaults.consolidation.coldStartFacts),
		diaryPerDay: z.natural().max(10).default(defaults.consolidation.diaryPerDay),
		narrativeEvidence: z.natural().default(defaults.consolidation.narrativeEvidence),
		retries: z.natural().max(10).default(defaults.consolidation.retries),
		dlqItems: z.natural().default(defaults.consolidation.dlqItems),
		dlqDays: z.natural().default(defaults.consolidation.dlqDays),
		aliasCount: z.natural().max(6).default(defaults.consolidation.aliasCount)
	}),
	segmentation: z.object({
		gapMinutes: z.natural().default(defaults.segmentation.gapMinutes),
		hardTopicJaccard: z.number().min(0).max(1).default(defaults.segmentation.hardTopicJaccard),
		softSalience: z.number().min(0).max(1).default(defaults.segmentation.softSalience),
		softDelta: z.number().min(0).max(1).default(defaults.segmentation.softDelta),
		microTopicJaccard: z.number().min(0).max(1).default(defaults.segmentation.microTopicJaccard),
		microSalience: z.number().min(0).max(1).default(defaults.segmentation.microSalience),
		minSecondary: z.natural().min(2).default(defaults.segmentation.minSecondary)
	}),
	decay: z.object({
		d: z.number().min(.1).max(4).default(defaults.decay.d),
		sInitial: z.number().min(1).default(defaults.decay.sInitial),
		sMaxMultiplier: z.number().min(1).default(defaults.decay.sMaxMultiplier),
		floor: z.number().min(0).max(1).default(defaults.decay.floor),
		retrievalBoost: z.number().min(0).default(defaults.decay.retrievalBoost),
		expiryHalfLifeDays: z.number().min(1).default(defaults.decay.expiryHalfLifeDays)
	}),
	emotion: z.object({
		l1Weight: z.number().min(0).max(2).default(defaults.emotion.l1Weight),
		subjectiveWeight: z.number().min(0).max(2).default(defaults.emotion.subjectiveWeight),
		boost: z.number().min(0).max(1).default(defaults.emotion.boost)
	}),
	retrieval: z.object({
		budgetTokens: z.natural().min(200).default(defaults.retrieval.budgetTokens),
		hardCapTokens: z.natural().min(200).default(defaults.retrieval.hardCapTokens),
		subjectiveShare: z.number().min(0).max(.8).default(defaults.retrieval.subjectiveShare),
		maxItems: z.natural().min(1).max(100).default(defaults.retrieval.maxItems),
		residentPreferences: z.natural().min(0).max(20).default(defaults.retrieval.residentPreferences),
		maxPlans: z.natural().min(0).max(10).default(defaults.retrieval.maxPlans),
		planNudgeDays: z.natural().min(0).max(90).default(defaults.retrieval.planNudgeDays),
		diaryShare: z.number().min(0).max(1).default(defaults.retrieval.diaryShare),
		minScore: z.number().min(0).max(1).default(defaults.retrieval.minScore),
		conflictPenalty: z.number().min(0).max(1).default(defaults.retrieval.conflictPenalty),
		unconfirmedBelow: z.number().min(0).max(1).default(defaults.retrieval.unconfirmedBelow),
		/**
		* Second pass over facts with OR instead of the implicit AND. Without it a
		* question that misses one bigram recalls nothing at all.
		*/
		relaxMatch: z.boolean().default(defaults.retrieval.relaxMatch),
		relaxBelow: z.natural().min(0).max(30).default(defaults.retrieval.relaxBelow),
		relaxPenalty: z.number().min(0).max(1).default(defaults.retrieval.relaxPenalty),
		relaxMinOverlap: z.number().min(0).max(1).default(defaults.retrieval.relaxMinOverlap),
		toneHint: z.boolean().default(defaults.retrieval.toneHint),
		layerPenalty: z.object({
			fact: z.number().min(0).max(1).default(defaults.retrieval.layerPenalty.fact),
			event: z.number().min(0).max(1).default(defaults.retrieval.layerPenalty.event),
			subjective: z.number().min(0).max(1).default(defaults.retrieval.layerPenalty.subjective),
			l0: z.number().min(0).max(1).default(defaults.retrieval.layerPenalty.l0)
		})
	}),
	roles: z.object({
		visitorPurgeHours: z.natural().min(1).default(defaults.roles.visitorPurgeHours),
		pendingDeleteDays: z.natural().min(1).default(defaults.roles.pendingDeleteDays),
		promotionVisits: z.natural().min(2).default(defaults.roles.promotionVisits),
		demotionDays: z.natural().min(1).default(defaults.roles.demotionDays)
	}),
	backup: z.object({
		enabled: z.boolean().default(defaults.backup.enabled),
		keep: z.natural().min(1).max(60).default(defaults.backup.keep),
		everyHours: z.number().min(1).max(720).default(defaults.backup.everyHours),
		dir: z.string().default(defaults.backup.dir)
	}),
	privacy: z.object({ masterCrossIdentity: z.boolean().default(defaults.privacy.masterCrossIdentity) }),
	prompt: z.object({
		personaOrder: z.number().default(10),
		protocolOrder: z.number().default(930),
		memoryOrder: z.number().default(900),
		indexOrder: z.number().default(895)
	}),
	diary: z.object({
		/** Mirror the diary to readable Markdown next to the database. */
		mirror: z.boolean().default(true),
		/** Mirror folder; relative values are resolved against the database's own folder. */
		mirrorDir: z.string().default("diary"),
		/** How many of the newest day files to (re)write when the plugin loads. */
		mirrorDays: z.natural().max(365).default(14)
	}),
	index: z.object({
		hooksBudgetTokens: z.natural().default(indexDefaults.hooksBudgetTokens),
		maxHooks: z.natural().min(1).default(indexDefaults.maxHooks),
		minHookScore: z.number().min(0).max(1).default(indexDefaults.minHookScore),
		expandBudgetTokens: z.natural().min(200).default(indexDefaults.expandBudgetTokens),
		maxCharsPerPack: z.natural().min(500).default(indexDefaults.maxCharsPerPack),
		rebuildMinutes: z.natural().default(indexDefaults.rebuildMinutes),
		coldDays: z.natural().default(indexDefaults.coldDays),
		includeAssistant: z.boolean().default(indexDefaults.includeAssistant)
	})
});
/**
* Flatten the plugin configuration into the engine's policy object.
* @param config - validated plugin config.
* @returns the engine configuration.
*/
function toEngineConfig(config) {
	return {
		locale: config.locale,
		l0: { ...config.l0 },
		decay: { ...config.decay },
		emotion: { ...config.emotion },
		retrieval: {
			...config.retrieval,
			layerPenalty: { ...config.retrieval.layerPenalty }
		},
		consolidation: {
			enabled: config.consolidation.enabled,
			triggerTokens: config.consolidation.triggerTokens,
			idleMinutes: config.consolidation.idleMinutes,
			maxRunSeconds: config.consolidation.maxRunSeconds,
			itemTimeoutSeconds: config.consolidation.itemTimeoutSeconds,
			retries: config.consolidation.retries,
			dlqItems: config.consolidation.dlqItems,
			dlqDays: config.consolidation.dlqDays,
			coldStartFacts: config.consolidation.coldStartFacts,
			diaryPerDay: config.consolidation.diaryPerDay,
			narrativeEvidence: config.consolidation.narrativeEvidence,
			sampleK: config.consolidation.sampleK,
			sampleM: config.consolidation.sampleM,
			dailyLlmCalls: config.consolidation.dailyLlmCalls,
			/*
			* Not optional to remember here: this function is an explicit
			* whitelist, so a field left out of it reaches the engine as
			* `undefined` and quietly falls back to the default. `aliasCount: 0`
			* then turns into 3 and the prompt keeps asking for aliases the
			* deployment asked to disable.
			*/
			aliasCount: config.consolidation.aliasCount
		},
		segmentation: { ...config.segmentation },
		roles: { ...config.roles },
		privacy: {
			masterCrossIdentity: config.privacy.masterCrossIdentity,
			crossIdentityRaw: false
		}
	};
}
/**
* Bounds the schema cannot express, checked once at load so a bad deployment
* fails loudly instead of at the first turn.
* @param config - validated config.
* @throws when a bound is inconsistent.
*/
function validateConfig(config) {
	if (config.path.length === 0) throw new Error("memory-loom: `path` must not be empty");
	if (config.timezone.length > 0 && !isValidTimeZone(config.timezone)) throw new Error(`memory-loom: timezone "${config.timezone}" is not a valid IANA zone`);
	if (config.retrieval.hardCapTokens < config.retrieval.budgetTokens) throw new Error("memory-loom: retrieval.hardCapTokens must be >= retrieval.budgetTokens");
	if (config.consolidation.maxRunSeconds <= config.consolidation.itemTimeoutSeconds) throw new Error("memory-loom: consolidation.maxRunSeconds must exceed itemTimeoutSeconds");
	/*
	* The prefix becomes part of every tool name, so it has to be a name
	* fragment and nothing else. Allowing `-` or a space produces a tool the
	* model's SDK cannot call, and the failure shows up as "the tool is missing"
	* rather than as a bad config value.
	*/
	if (!TOOL_PREFIX_PATTERN.test(config.toolPrefix)) throw new Error(`memory-loom: toolPrefix "${config.toolPrefix}" must start with a lowercase letter and contain only a-z, 0-9 and _ (e.g. "memory_", "loom_")`);
}

//#endregion
//#region src/engine/db.ts
/** Monotonic on-disk schema version. */
const SCHEMA_VERSION = 4;
/**
* 这份代码自己的版本号，不是磁盘上那个包的版本号。
*
* 为什么只能写死：DSH 的即时重组是在「bundle 第一次出现在列表里」时触发的，
* 同一个 bundle 原地换版本并不保证重新 import——旧模块可能还在缓存里，于是
* `node_modules` 写着 0.2.23、真正在跑的还是启动那一刻的代码。宿主没有接口
* 能问「你现在跑的是哪一版」，所以代码自己报：`memory_doctor` 打这一行，
* `check-docs.mjs` 在 CI 里盯它和 `package.json` 是否一致，改版忘了同步就红。
*/
const BUILD_VERSION = "0.2.31";
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS identities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('master','friend','visitor')),
    platform TEXT,
    platform_user_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_review','rejected','merged')),
    merged_into TEXT,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    purge_at INTEGER,
    metadata TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES identities(id),
    timezone TEXT,
    started_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    last_provider TEXT,
    last_model TEXT,
    turn_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER NOT NULL DEFAULT 0,
    consolidated_through INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS sessions_identity ON sessions(identity_id, last_active_at DESC);

  CREATE TABLE IF NOT EXISTS l0 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    turn INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    text TEXT NOT NULL,
    tokens TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    timezone TEXT,
    event_id INTEGER,
    consolidated INTEGER NOT NULL DEFAULT 0,
    purge_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS l0_session ON l0(session_id, id);
  CREATE INDEX IF NOT EXISTS l0_pending ON l0(consolidated, identity_id, id);
  CREATE INDEX IF NOT EXISTS l0_purge ON l0(purge_at);

  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id TEXT NOT NULL,
    text TEXT NOT NULL,
    tokens TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('fact','preference','instruction','plan','relationship')),
    source TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT 'other',
    subdomain TEXT,
    salience REAL NOT NULL DEFAULT 0,
    base REAL NOT NULL,
    stability REAL NOT NULL,
    stability_max REAL NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_access_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7,
    ttl TEXT NOT NULL DEFAULT 'none' CHECK (ttl IN ('none','absolute','relative')),
    expires_at INTEGER,
    due_from INTEGER,
    nudged_at INTEGER,
    resolved_at INTEGER,
    outcome TEXT,
    expired_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','disputed','pending_delete')),
    superseded_by INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    from_visitor INTEGER NOT NULL DEFAULT 0,
    isolated INTEGER NOT NULL DEFAULT 0,
    weight REAL NOT NULL DEFAULT 1,
    source_ids TEXT NOT NULL DEFAULT '[]',
    evidence TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS facts_identity ON facts(identity_id, status, updated_at DESC);
  CREATE INDEX IF NOT EXISTS facts_domain ON facts(identity_id, domain);
  CREATE INDEX IF NOT EXISTS facts_expiry ON facts(expires_at);
  CREATE INDEX IF NOT EXISTS facts_pinned ON facts(identity_id, pinned, updated_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    tokens, text, tags,
    content='facts', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts (rowid, tokens, text, tags) VALUES (new.id, new.tokens, new.text, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts (facts_fts, rowid, tokens, text, tags) VALUES ('delete', old.id, old.tokens, old.text, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts (facts_fts, rowid, tokens, text, tags) VALUES ('delete', old.id, old.tokens, old.text, old.tags);
    INSERT INTO facts_fts (rowid, tokens, text, tags) VALUES (new.id, new.tokens, new.text, new.tags);
  END;

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    tokens TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT 'other',
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    turn_from INTEGER NOT NULL,
    turn_to INTEGER NOT NULL,
    salience REAL NOT NULL DEFAULT 0,
    valence REAL NOT NULL DEFAULT 0,
    arousal REAL NOT NULL DEFAULT 0,
    l0_from INTEGER NOT NULL,
    l0_to INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_identity ON events(identity_id, ended_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    tokens, title, summary,
    content='events', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts (rowid, tokens, title, summary) VALUES (new.id, new.tokens, new.title, new.summary);
  END;
  CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts (events_fts, rowid, tokens, title, summary) VALUES ('delete', old.id, old.tokens, old.title, old.summary);
  END;
  CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
    INSERT INTO events_fts (events_fts, rowid, tokens, title, summary) VALUES ('delete', old.id, old.tokens, old.title, old.summary);
    INSERT INTO events_fts (rowid, tokens, title, summary) VALUES (new.id, new.tokens, new.title, new.summary);
  END;

  CREATE TABLE IF NOT EXISTS event_facts (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    fact_id INTEGER NOT NULL,
    PRIMARY KEY (event_id, fact_id)
  );

  CREATE TABLE IF NOT EXISTS memory_edges (
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    edge_type TEXT NOT NULL CHECK (edge_type IN ('SUPERSEDES','CONTRADICTS','CORROBORATES')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, edge_type)
  );

  CREATE TABLE IF NOT EXISTS narrative (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version INTEGER NOT NULL,
    text TEXT NOT NULL,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS impressions (
    identity_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    observations INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS diary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id TEXT NOT NULL,
    entry TEXT NOT NULL,
    day_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS diary_identity ON diary(identity_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS persona_zones (
    zone TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    editable_by TEXT NOT NULL CHECK (editable_by IN ('master','ai','both','none')),
    locked INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    source TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS persona_overlays (
    identity_id TEXT NOT NULL,
    zone TEXT NOT NULL,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (identity_id, zone)
  );

  CREATE TABLE IF NOT EXISTS persona_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone TEXT NOT NULL,
    old_text TEXT NOT NULL,
    new_text TEXT NOT NULL,
    source TEXT NOT NULL,
    actor TEXT NOT NULL,
    at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id TEXT NOT NULL,
    text TEXT NOT NULL,
    tokens TEXT NOT NULL,
    source_l0 INTEGER,
    created_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS preferences_identity ON preferences(identity_id, created_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS preferences_fts USING fts5(
    tokens, text,
    content='preferences', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS preferences_ai AFTER INSERT ON preferences BEGIN
    INSERT INTO preferences_fts (rowid, tokens, text) VALUES (new.id, new.tokens, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS preferences_ad AFTER DELETE ON preferences BEGIN
    INSERT INTO preferences_fts (preferences_fts, rowid, tokens, text) VALUES ('delete', old.id, old.tokens, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS preferences_au AFTER UPDATE ON preferences BEGIN
    INSERT INTO preferences_fts (preferences_fts, rowid, tokens, text) VALUES ('delete', old.id, old.tokens, old.text);
    INSERT INTO preferences_fts (rowid, tokens, text) VALUES (new.id, new.tokens, new.text);
  END;

  CREATE TABLE IF NOT EXISTS identity_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claimant_session TEXT NOT NULL,
    claimant_identity TEXT NOT NULL,
    claimed_identity TEXT,
    display_name TEXT NOT NULL,
    platform TEXT,
    platform_user_id TEXT,
    evidence TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    created_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    review_note TEXT
  );
  CREATE INDEX IF NOT EXISTS claims_status ON identity_claims(status, created_at);

  CREATE TABLE IF NOT EXISTS audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);

  CREATE TABLE IF NOT EXISTS usage_daily (
    identity_id TEXT NOT NULL,
    day TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (identity_id, day)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    dedupe_key TEXT UNIQUE
  );
  CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, next_at);

  CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    session_id TEXT,
    operation TEXT NOT NULL,
    channel TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    duration_ms INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS traces_at ON traces(at DESC);
`;
/**
* Open (creating if absent) the store and apply the schema.
* @param path - database file path, or `:memory:` for an ephemeral store.
* @returns the open connection.
*/
function openDatabase(path) {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new DatabaseSync(path);
	// WAL needs shared-memory support. Network shares, some FUSE mounts and a few
	// corporate roaming homes refuse it, and a throw here would take the whole
	// profile down before a single turn is recorded. Fall back to the rollback
	// journal instead: slower, but the store still works.
	try {
		db.exec("PRAGMA journal_mode = WAL");
	} catch {
		try {
			db.exec("PRAGMA journal_mode = DELETE");
		} catch {}
	}
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 5000");
	migrate(db);
	return db;
}
/**
* Add a column to an existing table when it is missing.
*
* `CREATE TABLE IF NOT EXISTS` leaves an older store untouched, so every
* column added after the first release needs this pass. `ALTER TABLE … ADD
* COLUMN` is cheap even on a large table: SQLite only rewrites the header.
* @param db - the open connection.
* @param table - table name (trusted, never user input).
* @param column - column name.
* @param ddl - the full column definition.
* @returns whether the column had to be added.
*/
function ensureColumn(db, table, column, ddl) {
	const existing = db.prepare(`PRAGMA table_info(${table})`).all();
	if (existing.some((row) => row["name"] === column)) return false;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
	return true;
}
function migrate(db) {
	const current = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
	db.exec(SCHEMA);
	// Retrieval aliases (v2). An older store keeps every row; only the new
	// column starts empty, and `memory_doctor` reports how many facts still
	// lack aliases so the gap is visible instead of silent.
	ensureColumn(db, "facts", "aliases", "aliases TEXT NOT NULL DEFAULT ''");
	ensureColumn(db, "events", "aliases", "aliases TEXT NOT NULL DEFAULT ''");
	/*
	* Due windows (v3). `expires_at` already held the end of the window; what
	* was missing is its start, which is the difference between "下周一" (one
	* day) and "下周" (seven). Old rows keep `due_from = NULL` and render as a
	* single date, which is what they were.
	*/
	ensureColumn(db, "facts", "due_from", "due_from INTEGER");
	/*
	* Plan outcomes (v4). A plan that reached its date is not a result, it is a
	* question: did it happen? `resolved_at` and `outcome` are the answer, and
	* they are the only thing that stops the question — `nudged_at` is when the
	* block last asked, i.e. the anchor of the re-ask interval (v0.2.23), not a
	* one-shot latch. Old rows keep all three NULL, which reads as "still open,
	* never asked" — and that is correct: nobody ever asked them.
	*/
	ensureColumn(db, "facts", "nudged_at", "nudged_at INTEGER");
	ensureColumn(db, "facts", "resolved_at", "resolved_at INTEGER");
	ensureColumn(db, "facts", "outcome", "outcome TEXT");
	// Only stamp forward: opening a store written by a newer build must not
	// pretend to have downgraded it.
	if (current < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
/** Flush the write-ahead log so another process sees every committed turn (Q50 emergency flush). */
function checkpoint(db) {
	try {
		db.exec("PRAGMA wal_checkpoint(PASSIVE)");
	} catch {}
}

//#endregion
//#region src/engine/text.ts
/**
* Text primitives shared by every layer: CJK-aware tokenization for FTS5,
* similarity, token budgeting, secret redaction and the small classifiers the
* rule pipeline needs.
*
* SQLite's `unicode61` tokenizer treats a run of Han characters as one token,
* so a Chinese sentence would be searchable only as a whole. Indexing the
* conversation as CJK bigrams (and querying in the same form) gives substring
* recall without a dictionary segmenter, a model download or a network call.
*
* @module dsh-memory-loom/engine/text
*/
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_RUN = /[A-Za-z][A-Za-z0-9_'-]*/g;
const DIGIT_RUN = /\d+(?:[.:-]\d+)*/g;
/** Collapse whitespace without touching content. */
function squeeze(text) {
	return text.replace(/\s+/gu, " ").trim();
}
/**
* Words that are too generic to be a retrieval alias.
*
* An alias is indexed next to the fact, so it widens what the fact can be
* found by. That is the point — and also the risk: 「工作」「心情」 appear in
* half of all conversations, so an alias like that turns one memory into a
* magnet for every unrelated turn. The list is deliberately short: it only
* holds words that carry no object at all. Anything naming a thing, a person,
* a place or a project stays.
*/
/** One Han character. A non-global copy, so `.test()` keeps no state. */
const HAN_CHAR = /\p{Script=Han}/u;
const GENERIC_ALIASES = new Set([
	"工作",
	"生活",
	"心情",
	"情绪",
	"感觉",
	"觉得",
	"事情",
	"问题",
	"东西",
	"状态",
	"情况",
	"内容",
	"方式",
	"方法",
	"时候",
	"时间",
	"今天",
	"最近",
	"现在",
	"以后",
	"之前",
	"聊天",
	"对话",
	"话题",
	"计划",
	"学习",
	"用户",
	"我们",
	"你们",
	"他们",
	"自己",
	"一下",
	"一些",
	"有点",
	"真的",
	"其实",
	"可能",
	/*
	* 问句壳。提示词现在要的是「他会怎么问」，模型很容易顺手给一个只剩疑问
	* 词的别名：「什么时候」「怎么样」。这类词挂在一条事实上就成了磁铁 ——
	* 用户问任何事都带着它们，于是这条记忆对每个问题都算命中。真正有用的是
	* 带着对象的那一半（「身体怎么样」），所以这里只挡掉光秃秃的壳。
	*/
	"怎么样",
	"怎么办",
	"为什么",
	"什么时候",
	"多少钱",
	"有没有",
	"是不是",
	"好不好",
	"要不要",
	"哪些",
	"哪个"
]);
/**
* Keep the useful retrieval aliases out of whatever the model wrote.
*
* A model asked for "the words the user might search this by" produces three
* kinds of junk: whole sentences, discourse words (「其实」「有点」), and the
* fact itself. Each one either bloats the index or turns the fact into a
* magnet, so all three are dropped here rather than trusted upstream.
* @param input - raw value from a model reply, a tool argument or a config.
* @param limit - how many aliases to keep (0 disables the feature).
* @returns the accepted aliases, deduplicated, in the given order.
*/
function cleanAliases(input, limit = 3) {
	const accepted = [];
	if (limit <= 0 || !Array.isArray(input)) return accepted;
	for (const raw of input) {
		if (typeof raw !== "string") continue;
		const alias = squeeze(raw).replace(/[「」『』“”"'‘’《》，,。．.、；;：:！!？?（）()【】[\]]/gu, "").trim();
		const maxLength = HAN_CHAR.test(alias) ? 6 : 12;
		if (alias.length < 2 || alias.length > maxLength) continue;
		if (GENERIC_ALIASES.has(alias)) continue;
		if (/^\d+$/u.test(alias)) continue;
		if (containsSecret(alias)) continue;
		if (accepted.includes(alias)) continue;
		accepted.push(alias);
		if (accepted.length >= limit) break;
	}
	return accepted;
}
/** The alias column: space joined, because that is how the index wants it. */
function aliasColumn(input, limit = 3) {
	return cleanAliases(input, limit).join(" ");
}
/**
* Split text into index tokens: bigrams for CJK runs, lowercase words for
* Latin runs, and bare numbers.
* @param text - arbitrary text.
* @returns the token list, duplicates preserved (FTS wants term frequency).
*/
function tokensOf(text) {
	const tokens = [];
	for (const match of text.matchAll(CJK_RUN)) {
		const chars = [...match[0]];
		for (let index = 0; index < chars.length - 1; index++) tokens.push(`${chars[index]}${chars[index + 1]}`);
		if (chars.length === 1) tokens.push(chars[0]);
	}
	for (const match of text.matchAll(LATIN_RUN)) tokens.push(match[0].toLowerCase());
	for (const match of text.matchAll(DIGIT_RUN)) tokens.push(match[0]);
	return tokens;
}
/** The bigram/word index of a text block, space joined for FTS5. */
function indexText(text) {
	return tokensOf(text).join(" ");
}
/** Above this length L0 skips tokenising: the column has no reader (see `l0TokensOf`). */
const L0_TOKENISE_LIMIT = 8e3;
/**
* Token column for one L0 row.
*
* `l0.tokens` is never read back — `l0From` does not map it, and FTS only covers
* facts / events / preferences. Storing it anyway costs a 1.6x copy of every
* message and a full tokenise pass, which is why long rows store an empty string.
* @param text - the message about to be stored.
* @returns the token string, or `""` for long rows.
*/
function l0TokensOf(text) {
	return text.length > L0_TOKENISE_LIMIT ? "" : indexText(text);
}
/** Deduplicated token set, used for Jaccard similarity. */
function tokenSet(text) {
	return new Set(tokensOf(text));
}
/**
* Jaccard similarity of two texts in token space.
* @param a - first text.
* @param b - second text.
* @returns 0 when either side has no token, otherwise |A∩B| / |A∪B|.
*/
function jaccard(a, b) {
	const left = tokenSet(a);
	const right = tokenSet(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / (left.size + right.size - shared);
}
/**
* Fold a sentence down to what a quote test compares: no spacing, no
* punctuation, no case.
*
* Punctuation is dropped because a model re-punctuating its own excerpt says
* nothing about whether the words were in the source — 「我不吃香菜，闻着难受」
* and 「我不吃香菜 闻着难受」 are the same evidence.
* @param text - any string.
* @returns the comparable form.
*/
function quoteKey(text) {
	return String(text).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}
/**
* Did the extractor's excerpt really come from the segment it claims?
*
* This is the checksum, not the retransmission: one local substring test
* answers 「原文里到底有没有这句」, with no second model call. Three outcomes
* matter and they are not the same thing — `true` (found), `false` (not
* found, so the fact may be composed rather than read), and `null` (no usable
* excerpt: nothing to check). A `null` must never be counted as a failure, or
* every rule-path fact and every reply that forgot the field would read as a
* hallucination.
*
* Ellipses split the excerpt into pieces that must *each* appear, so quoting
* 「下周三去北京……挂的上午号」 works without the words in between.
* @param quote - the excerpt the model reported, if any.
* @param source - the conversation segment it was read from.
* @returns true / false, or null when there is nothing to test.
*/
function quoteMatches(quote, source) {
	if (typeof quote !== "string") return null;
	const parts = quote.split(/…|\.{3,}/u).map(quoteKey).filter((part) => part.length >= 4);
	if (parts.length === 0) return null;
	const haystack = quoteKey(source);
	return parts.every((part) => haystack.includes(part));
}
/** How much of `needle` is covered by `haystack`, in [0,1]. */
function containment(needle, haystack) {
	const small = tokenSet(needle);
	const large = tokenSet(haystack);
	if (small.size === 0) return 0;
	let shared = 0;
	for (const token of small) if (large.has(token)) shared++;
	return shared / small.size;
}
/**
* What a stored row can be found by: its own words plus the aliases the model
* wrote on it. Used wherever a decision compares a query against a row, so a
* paraphrase counts as the same words instead of as an unrelated sentence.
* @param row - a fact (with `text`) or anything already rendered to a line.
* @returns the searchable text.
*/
function rowText(row) {
	const aliases = typeof row.aliases === "string" ? row.aliases.trim() : "";
	return aliases.length === 0 ? String(row.text) : `${String(row.text)} ${aliases}`;
}
/**
* Compile a free-text query into an FTS5 MATCH expression. Every token is
* quoted so operators the model types are matched literally; tokens combine
* with implicit AND.
* @param query - raw query text.
* @param limit - maximum number of tokens kept.
* @returns the MATCH expression, or undefined when nothing usable remains.
*/
function compileMatch(query, limit = 24) {
	const unique = [...new Set(tokensOf(query))].slice(0, limit);
	if (unique.length === 0) return void 0;
	return unique.map((token) => `"${token.replaceAll("\"", "\"\"")}"`).join(" ");
}
/**
* The same tokens joined with OR instead of FTS5's implicit AND.
*
* `compileMatch` requires *every* bigram of the user's sentence to appear in the
* stored text, which is why a long question almost never recalled a standing
* preference. Recall uses this looser form for the preference zone, where a
* single overlapping bigram is already a useful signal; bm25 still ranks entries
* that match more of them first.
*/
function compileLooseMatch(query, limit = 12) {
	const unique = [...new Set(tokensOf(query))].slice(0, limit);
	if (unique.length === 0) return void 0;
	return unique.map((token) => `"${token.replaceAll("\"", "\"\"")}"`).join(" OR ");
}
/**
* Approximate token count for budgeting. CJK characters cost about 0.65
* tokens, Latin text about one token per four characters, and punctuation
* almost nothing; this errs on the generous side.
* @param text - the text to measure.
* @returns an estimated token count.
*/
function estimateTokens(text) {
	let cjk = 0;
	let latin = 0;
	let other = 0;
	for (const char of text) if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) cjk++;
	else if (/[A-Za-z0-9]/u.test(char)) latin++;
	else other++;
	return Math.ceil(cjk * .65 + latin / 4 + other * .25);
}
/** Clip text to `maxChars`, appending an ellipsis when something was cut. */
function clip(text, maxChars) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
/** Note appended to a message that was cut before storage, so nobody assumes it is whole. */
const TRUNCATION_NOTE = (kept, total) => `\n…[已截断：原消息 ${total} 字，仅保留前 ${kept} 字。要留存全文请调大 l0.maxCharsPerMessage，或分段发送]`;
/**
* Prepare one message for L0.
*
* Redaction always runs on the whole message. The cap, when enabled, only drops
* the tail — and says so in the stored text: a silent cut makes the model read a
* partial log or code block as if it were complete.
* @param text - already-redacted message text.
* @param maxChars - storage cap in characters; `0` or negative stores verbatim.
* @returns the text to store.
*/
function storeText(text, maxChars) {
	if (!(maxChars > 0) || text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}${TRUNCATION_NOTE(maxChars, text.length)}`;
}
const SECRET_PATTERNS = [
	{
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
		mask: "[redacted private key]"
	},
	{
		pattern: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gu,
		mask: "[redacted api key]"
	},
	{
		pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
		mask: "[redacted token]"
	},
	{
		pattern: /\bAKIA[0-9A-Z]{16}\b/gu,
		mask: "[redacted access key]"
	},
	{
		pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/giu,
		mask: "Bearer [redacted]"
	},
	{
		pattern: /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"',;]{4,}/giu,
		mask: "[redacted credential]"
	},
	{
		pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/gu,
		mask: "[redacted phone]"
	},
	{
		pattern: /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/gu,
		mask: "[redacted id number]"
	},
	{
		pattern: /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/gu,
		mask: "[redacted card number]"
	}
];
/**
* Remove credential-shaped material before anything is written to disk.
* Detection is deliberately conservative: it protects obvious keys, phone
* numbers and identity numbers, and leaves ordinary prose alone.
* @param text - any text bound for storage.
* @returns the text with secrets masked.
*/
function redactSecrets(text) {
	let out = text;
	for (const { pattern, mask } of SECRET_PATTERNS) out = out.replace(pattern, mask);
	return out;
}
/** Whether the text looks like it carries a credential. */
function containsSecret(text) {
	return SECRET_PATTERNS.some(({ pattern }) => {
		pattern.lastIndex = 0;
		return pattern.test(text);
	});
}
const INSTRUCTION_MARKERS = [
	/记住/u,
	/别忘/u,
	/以后(?:都|要|不要|每次)/u,
	/每次(?:都|要)/u,
	/不许/u,
	/禁止/u,
	/务必/u,
	/一定要/u,
	/\b(?:always|never|remember to|from now on|must not|do not)\b/iu
];
/**
* Whether a statement is an instruction about how to behave. Such statements
* are isolated into the preference zone instead of normal recall (Q44).
* @param text - candidate statement.
* @returns true for behavioural instructions and standing rules.
*/
function looksInstructional(text) {
	return INSTRUCTION_MARKERS.some((pattern) => pattern.test(text));
}
const PREFERENCE_MARKERS = [
	/我(?:最)?(?:喜欢|偏好|爱|讨厌|不喜欢|习惯|想要|希望)/u,
	/我(?:的)?(?:生日|名字|住|在|是)/u,
	/\bI (?:like|love|prefer|hate|dislike|live in|work at|was born)\b/iu
];
/*
* Negative preferences. 「我不吃香菜」 is the canonical standing preference and
* the rule path has never been able to see it: `PREFERENCE_MARKERS` collects
* 不喜欢 but not 不吃, so the one sentence everyone tests memory with was the
* one it dropped.
*
* The reason it was left out is real — 「今天不吃早饭」 has the same shape and is
* a one-off. Writing that into the preference zone means every later meal gets
* vetoed by a Tuesday, and the user has no way to explain that it was never a
* taste. So the marker alone is not enough; `looksDietary` asks when as well.
*/
const DIET_MARKERS = [
	/(?:不吃|不喝|不碰|受不了|忌口|戒了|戒掉|过敏)/u,
	/\b(?:do not eat|don't eat|allergic to|can't stand|gave up)\b/iu
];
/**
* Whether a time word sits right before the marker, which turns a standing
* preference into a single meal.
*
* Deliberately narrow: only a same-day word counts. 「我下个月不吃辣」 is still a
* preference with a date on it, and dropping it would lose the only kind of
* statement that has both.
*/
const SAME_DAY_BEFORE = /(?:今天|昨天|昨晚|今晚|中午|早上|这顿|这两天)[^，。！？]{0,3}$/u;
/**
* Whether a statement carries a stable personal preference or profile fact.
* @param text - candidate statement.
* @returns true for preferences, profile rows and standing dietary limits.
*/
function looksPreference(text) {
	if (PREFERENCE_MARKERS.some((pattern) => pattern.test(text))) return true;
	for (const pattern of DIET_MARKERS) {
		const at = text.search(pattern);
		if (at < 0) continue;
		if (SAME_DAY_BEFORE.test(text.slice(Math.max(0, at - 12), at))) continue;
		return true;
	}
	return false;
}
/** Identity rows: name, home, employer, birthday, marital status. */
const PROFILE_MARKERS = [
	/(?:我叫|我的名字|我住|我在.{0,12}(?:工作|上班|上学)|我的生日|我(?:今年)?\d+岁|我(?:已经)?(?:结婚|离婚|毕业))/u,
	/\b(?:my name is|i live in|i work at|my birthday)\b/iu
];
/*
* What the user did, ran into, or got to. This group did not exist, and its
* absence is what a real store showed: 13 episodes, 10 with no facts at all,
* six of them technical. Those episodes were not empty — 「今天把迁移脚本改完了」
* carries the only sentence anyone would later search for. The rubric simply
* had no slot for "something he did", so the fallback returned nothing and the
* episode became a title-only block.
*
* The group is intentionally broad, because it only runs when there is no
* model, and the choice there is between a rough searchable row and silence.
* It cannot run away: at most six rows per segment, sentences over 220
* characters and anything credential-shaped are dropped first.
*/
const EXPERIENCE_MARKERS = [
	/我(?:今天|昨天|前天|上周|上个月|刚才|刚刚|昨晚|已经|终于|还是|又|刚)?[^，。！？]{0,8}(?:做|写|改|修|弄|跑|发|交|签|买|卖|换|搬|辞|退|报|考|约|见|开始|完成|搞定|上线|提交|部署|跑通|入职|离职)/u,
	/我(?:遇到|碰到|发现|卡在|正在|在弄|在改|在写|在跑|在等|试了|定了)/u,
	/*
	* 中文说话经常不带主语：「今天把迁移脚本改完了」没有「我」，而它恰恰是
	* 这段对话里唯一值得记的一句。上面的词表全要求「我」，于是这句话在降级
	* 路径上仍然一条也抽不出来 —— 补了「经历」这一组却漏掉最常见的句式，
	* 等于没补。这两条不需要主语，靠「完成态动词」站位。
	*/
	/把[^，。！？]{1,16}(?:改完|写完|做完|弄完|修好|搞定|交了|发了|跑通|删了|换成)/u,
	/(?:今天|昨天|前天|上午|下午|晚上|刚刚|刚才|昨晚)[^，。！？]{0,12}(?:做完|写完|改完|弄完|修好|搞定|弄明白|上线|提交|部署|交了|签了|跑通|发出去|回来了|出发了)/u,
	/(?:卡在|搞不定|弄不完|来不及|说好了|定下来了)/u,
	/\bI (?:finished|started|built|shipped|fixed|wrote|moved|quit|bought|booked|met|joined)\b/iu
];
/*
* 明确带值的陈述句。
*
* 上面几组认的都是「谁做了什么」——人的经历、计划、要求。这一组认的是
* 「什么是什么」——对象的属性、配置、命名。缺了它，规则路径对「依赖名
* 调整为 badger」「超时设成 30 秒」这类句子完全无感，而后者恰恰是几个月
* 后还会被问起的那类信息；在没有模型的机器上，等于这些事从未发生。
*
* 刻意不收「数字 + 单位」这个形状：它在闲聊里太密（「等了 3 分钟」
* 「花了 200 块」），收进来是把噪音写进记忆；而记忆里的噪音比没记更贵，
* 它会在此后每次检索里参与排序。
*/
const FACT_MARKERS = [
	/(?:改|换|调|设|升|降)(?:整|动)?(?:成|为|到)\s*[^，。！？；\s]{1,24}/u,
	/(?:默认值?|上限|下限|阈值|超时|端口|版本号?|依赖|配置项?|路径|地址|表名|字段名)[^，。！？；]{0,12}(?:是|为|改成|改成了|调整为|设成|设为|换成|换成了)/u,
	/(?:叫|名为|命名为|取名为|简称)\s*[^，。！？；\s]{1,24}/u
];
/** Things the user said, scheduled or asked to be reminded of. */
const TEMPORAL_MARKERS = [
	/(?:明天|后天|下周|下个月|三天后|以后|打算|计划|准备)/u,
	/\b(?:next week|tomorrow)\b/iu
];
const REMINDER_MARKERS = [
	/(?:记住|记一下|别忘了|提醒我)/u,
	/\bremember\b/iu
];
/**
* Whether a sentence deserves a row on the model-free path.
*
* Kept in one place so that widening the rubric is a visible edit: the old
* version was a single 240-character `if` inside `extractWithRules`, where a
* missing category read as a regex detail and never as a decision.
* @param text - one sentence of user speech.
* @returns true if any group recognises it.
*/
function looksWorthKeeping(text) {
	if (looksPreference(text) || looksInstructional(text)) return true;
	return [...PROFILE_MARKERS, ...EXPERIENCE_MARKERS, ...FACT_MARKERS, ...TEMPORAL_MARKERS, ...REMINDER_MARKERS].some((pattern) => pattern.test(text));
}
/** Normalize a tag list to the lowercase, deduplicated, space-joined form stored in `tags`. */
function normalizeTags(tags) {
	const seen = /* @__PURE__ */ new Set();
	for (const tag of tags) {
		const normalized = tag.trim().toLowerCase().replaceAll(/\s+/gu, "-");
		if (normalized.length > 0) seen.add(normalized);
	}
	return [...seen].join(" ");
}
/** Split text into sentence-ish units without breaking on decimals or abbreviations. */
function sentences(text) {
	const parts = squeeze(text).split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z一-鿿])/u).map((part) => part.trim()).filter((part) => part.length > 0);
	return parts.length > 0 ? parts : [text];
}

//#endregion
//#region src/engine/store.ts
function asString$1(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}
function asNumber$1(value, fallback = 0) {
	return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : fallback;
}
function asNullableNumber(value) {
	return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
}
function asBoolean(value) {
	return asNumber$1(value) !== 0;
}
function parseJson(value, fallback) {
	if (typeof value !== "string") return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}
function identityFrom(row) {
	return {
		id: asString$1(row["id"]),
		name: asString$1(row["name"]),
		role: asString$1(row["role"], "visitor"),
		platform: typeof row["platform"] === "string" ? row["platform"] : null,
		platformUserId: typeof row["platform_user_id"] === "string" ? row["platform_user_id"] : null,
		status: asString$1(row["status"], "active"),
		mergedInto: typeof row["merged_into"] === "string" ? row["merged_into"] : null,
		createdAt: asNumber$1(row["created_at"]),
		lastActiveAt: asNumber$1(row["last_active_at"]),
		purgeAt: asNullableNumber(row["purge_at"]),
		metadata: parseJson(row["metadata"], {})
	};
}
function sessionFrom(row) {
	return {
		sessionId: asString$1(row["session_id"]),
		identityId: asString$1(row["identity_id"]),
		timezone: typeof row["timezone"] === "string" ? row["timezone"] : null,
		startedAt: asNumber$1(row["started_at"]),
		lastActiveAt: asNumber$1(row["last_active_at"]),
		lastProvider: typeof row["last_provider"] === "string" ? row["last_provider"] : null,
		lastModel: typeof row["last_model"] === "string" ? row["last_model"] : null,
		turnCount: asNumber$1(row["turn_count"]),
		tokenCount: asNumber$1(row["token_count"]),
		consolidatedThrough: asNumber$1(row["consolidated_through"])
	};
}
function l0From(row) {
	return {
		id: asNumber$1(row["id"]),
		sessionId: asString$1(row["session_id"]),
		identityId: asString$1(row["identity_id"]),
		turn: asNumber$1(row["turn"]),
		role: asString$1(row["role"], "user"),
		text: asString$1(row["text"]),
		createdAt: asNumber$1(row["created_at"]),
		timezone: typeof row["timezone"] === "string" ? row["timezone"] : null,
		eventId: asNullableNumber(row["event_id"]),
		consolidated: asBoolean(row["consolidated"]),
		purgeAt: asNullableNumber(row["purge_at"])
	};
}
function factFrom(row) {
	return {
		id: asNumber$1(row["id"]),
		identityId: asString$1(row["identity_id"]),
		text: asString$1(row["text"]),
		aliases: asString$1(row["aliases"], ""),
		kind: asString$1(row["kind"], "fact"),
		source: asString$1(row["source"], "dialogue"),
		domain: asString$1(row["domain"], "other"),
		subdomain: typeof row["subdomain"] === "string" ? row["subdomain"] : null,
		tags: asString$1(row["tags"]),
		salience: asNumber$1(row["salience"]),
		base: asNumber$1(row["base"], .55),
		stability: asNumber$1(row["stability"], 30),
		stabilityMax: asNumber$1(row["stability_max"], 1500),
		accessCount: asNumber$1(row["access_count"]),
		lastAccessAt: asNumber$1(row["last_access_at"]),
		createdAt: asNumber$1(row["created_at"]),
		updatedAt: asNumber$1(row["updated_at"]),
		confidence: asNumber$1(row["confidence"], .7),
		ttl: asString$1(row["ttl"], "none"),
		expiresAt: asNullableNumber(row["expires_at"]),
		dueFrom: asNullableNumber(row["due_from"]),
		nudgedAt: asNullableNumber(row["nudged_at"]),
		resolvedAt: asNullableNumber(row["resolved_at"]),
		outcome: typeof row["outcome"] === "string" ? row["outcome"] : null,
		expiredAt: asNullableNumber(row["expired_at"]),
		status: asString$1(row["status"], "active"),
		supersededBy: asNullableNumber(row["superseded_by"]),
		pinned: asBoolean(row["pinned"]),
		fromVisitor: asBoolean(row["from_visitor"]),
		isolated: asBoolean(row["isolated"]),
		weight: asNumber$1(row["weight"], 1),
		sourceIds: parseJson(row["source_ids"], []),
		evidence: parseJson(row["evidence"], {})
	};
}
function eventFrom(row) {
	return {
		id: asNumber$1(row["id"]),
		identityId: asString$1(row["identity_id"]),
		sessionId: asString$1(row["session_id"]),
		title: asString$1(row["title"]),
		summary: asString$1(row["summary"]),
		aliases: asString$1(row["aliases"], ""),
		domain: asString$1(row["domain"], "other"),
		startedAt: asNumber$1(row["started_at"]),
		endedAt: asNumber$1(row["ended_at"]),
		turnFrom: asNumber$1(row["turn_from"]),
		turnTo: asNumber$1(row["turn_to"]),
		salience: asNumber$1(row["salience"]),
		valence: asNumber$1(row["valence"]),
		arousal: asNumber$1(row["arousal"]),
		l0From: asNumber$1(row["l0_from"]),
		l0To: asNumber$1(row["l0_to"]),
		factIds: [],
		status: asString$1(row["status"], "active"),
		createdAt: asNumber$1(row["created_at"])
	};
}
function narrativeFrom(row) {
	return {
		id: asNumber$1(row["id"]),
		version: asNumber$1(row["version"]),
		text: asString$1(row["text"]),
		evidenceCount: asNumber$1(row["evidence_count"]),
		createdAt: asNumber$1(row["created_at"]),
		archived: asBoolean(row["archived"])
	};
}
/** The store: one connection, typed statements, no policy. */
var MemoryStore = class {
	db;
	constructor(db) {
		this.db = db;
	}
	/** Read one meta value. */
	getMeta(key) {
		const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
		return row === void 0 ? void 0 : asString$1(row["value"]);
	}
	/** Write one meta value. */
	setMeta(key, value) {
		this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
	}
	/** Close the connection; idempotent. */
	close() {
		try {
			this.db.close();
		} catch {}
	}
	/** Create the master identity if it does not exist yet. */
	ensureMaster(id, name$1, now) {
		const existing = this.getIdentity(id);
		if (existing !== void 0) return existing;
		this.db.prepare(`
      INSERT INTO identities (id, name, role, status, created_at, last_active_at, metadata)
      VALUES (?, ?, 'master', 'active', ?, ?, '{}')
    `).run(id, name$1, now, now);
		return this.getIdentity(id);
	}
	/** Fetch one identity. */
	getIdentity(id) {
		const row = this.db.prepare("SELECT * FROM identities WHERE id = ?").get(id);
		return row === void 0 ? void 0 : identityFrom(row);
	}
	/** All identities, oldest first. */
	listIdentities() {
		return this.db.prepare("SELECT * FROM identities ORDER BY created_at ASC").all().map(identityFrom);
	}
	/** Insert or update an identity row. */
	upsertIdentity(identity) {
		this.db.prepare(`
      INSERT INTO identities (id, name, role, platform, platform_user_id, status, merged_into, created_at, last_active_at, purge_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, role = excluded.role, platform = excluded.platform,
        platform_user_id = excluded.platform_user_id, status = excluded.status,
        merged_into = excluded.merged_into, last_active_at = excluded.last_active_at,
        purge_at = excluded.purge_at, metadata = excluded.metadata
    `).run(identity.id, identity.name, identity.role, identity.platform, identity.platformUserId, identity.status, identity.mergedInto, identity.createdAt, identity.lastActiveAt, identity.purgeAt, JSON.stringify(identity.metadata));
	}
	/** Update only the mutable identity fields. */
	touchIdentity(id, now, purgeAt) {
		this.db.prepare("UPDATE identities SET last_active_at = ?, purge_at = ? WHERE id = ?").run(now, purgeAt, id);
	}
	/** Change role/status and purge deadline together. */
	setIdentityRole(id, role, status, purgeAt) {
		this.db.prepare("UPDATE identities SET role = ?, status = ?, purge_at = ? WHERE id = ?").run(role, status, purgeAt, id);
	}
	/** Fetch a session row. */
	getSession(sessionId) {
		const row = this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
		return row === void 0 ? void 0 : sessionFrom(row);
	}
	/** Create a session row bound to an identity, or rebind an existing one. */
	upsertSession(sessionId, identityId, now, timezone) {
		const existing = this.getSession(sessionId);
		if (existing === void 0) this.db.prepare(`
        INSERT INTO sessions (session_id, identity_id, timezone, started_at, last_active_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(sessionId, identityId, timezone, now, now);
		else if (existing.identityId !== identityId || timezone !== null && existing.timezone !== timezone) this.db.prepare("UPDATE sessions SET identity_id = ?, timezone = ? WHERE session_id = ?").run(identityId, timezone ?? existing.timezone, sessionId);
		return this.getSession(sessionId);
	}
	/** Update activity, counters and the pending-consolidation trigger. */
	touchSession(sessionId, now, tokens, turnCompleted) {
		this.db.prepare(`
      UPDATE sessions SET last_active_at = ?, token_count = token_count + ?,
        turn_count = turn_count + ? WHERE session_id = ?
    `).run(now, Math.max(0, Math.round(tokens)), turnCompleted ? 1 : 0, sessionId);
	}
	/** Record the route used by the session's last model request. */
	noteRoute(sessionId, provider, model) {
		this.db.prepare("UPDATE sessions SET last_provider = ?, last_model = ? WHERE session_id = ?").run(provider, model, sessionId);
	}
	/** Reset the accumulated trigger after a successful consolidation. */
	resetSessionCounters(sessionId, consolidatedThrough) {
		this.db.prepare("UPDATE sessions SET token_count = 0, consolidated_through = ? WHERE session_id = ?").run(consolidatedThrough, sessionId);
	}
	/** Sessions with unconsolidated turns that are due. */
	sessionsDue(now, triggerTokens, idleMinutes) {
		const idleMs = idleMinutes * 6e4;
		return this.db.prepare(`
      SELECT s.* FROM sessions s
      WHERE EXISTS (SELECT 1 FROM l0 WHERE l0.session_id = s.session_id AND l0.consolidated = 0)
        AND (s.token_count >= ? OR s.last_active_at <= ?)
      ORDER BY s.last_active_at ASC
      LIMIT 20
    `).all(triggerTokens, now - idleMs).map(sessionFrom);
	}
	/** All sessions, for export and maintenance. */
	listSessions() {
		return this.db.prepare("SELECT * FROM sessions ORDER BY last_active_at DESC").all().map(sessionFrom);
	}
	/** Append one raw message. */
	appendL0(input) {
		return asNumber$1(this.db.prepare(`
      INSERT INTO l0 (session_id, identity_id, turn, role, text, tokens, created_at, timezone, purge_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(input.sessionId, input.identityId, input.turn, input.role, input.text, l0TokensOf(input.text), input.createdAt, input.timezone, input.purgeAt)["id"]);
	}
	/** Unconsolidated rows for one session, oldest first. */
	pendingL0(sessionId, limit = 400) {
		return this.db.prepare(`
      SELECT * FROM l0 WHERE session_id = ? AND consolidated = 0 ORDER BY id ASC LIMIT ?
    `).all(sessionId, limit).map(l0From);
	}
	/** Unconsolidated rows for one identity across sessions (used by the idle sweeper). */
	pendingL0ForIdentity(identityId, limit = 400) {
		return this.db.prepare(`
      SELECT * FROM l0 WHERE identity_id = ? AND consolidated = 0 ORDER BY id ASC LIMIT ?
    `).all(identityId, limit).map(l0From);
	}
	/** Mark rows as folded into an event. */
	markL0Consolidated(ids) {
		if (ids.length === 0) return;
		const statement = this.db.prepare("UPDATE l0 SET consolidated = 1 WHERE id = ?");
		for (const id of ids) statement.run(id);
	}
	/** Attach rows to an event. */
	assignL0Event(ids, eventId) {
		if (ids.length === 0) return;
		const statement = this.db.prepare("UPDATE l0 SET event_id = ? WHERE id = ?");
		for (const id of ids) statement.run(eventId, id);
	}
	/** Rows by id, preserving the given order. */
	l0ByIds(ids) {
		if (ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(",");
		const rows = this.db.prepare(`SELECT * FROM l0 WHERE id IN (${placeholders})`).all(...ids);
		const byId = new Map(rows.map((row) => [asNumber$1(row["id"]), l0From(row)]));
		return ids.map((id) => byId.get(id)).filter((record) => record !== void 0);
	}
	/** Raw rows between two ids, inclusive, oldest first. */
	l0Range(fromId, toId) {
		return this.db.prepare("SELECT * FROM l0 WHERE id >= ? AND id <= ? ORDER BY id ASC").all(fromId, toId).map(l0From);
	}
	/** Recent raw turns of one identity, newest first. */
	recentL0(identityId, limit) {
		return this.db.prepare(`
      SELECT * FROM l0 WHERE identity_id = ? ORDER BY id DESC LIMIT ?
    `).all(identityId, limit).map(l0From);
	}
	/** Count remaining raw turns of an identity. */
	countL0(identityId) {
		return asNumber$1(this.db.prepare("SELECT COUNT(*) AS n FROM l0 WHERE identity_id = ?").get(identityId)["n"]);
	}
	/** Hard-delete every raw turn of one identity (a friend's deletion request, Q62). */
	deleteL0ForIdentity(identityId) {
		return this.db.prepare("DELETE FROM l0 WHERE identity_id = ? RETURNING id").all(identityId).length;
	}
	/** Hard-delete one identity's raw turns whose purge deadline has passed. */
	purgeExpiredL0ForIdentity(identityId, now) {
		return this.db.prepare("DELETE FROM l0 WHERE identity_id = ? AND purge_at IS NOT NULL AND purge_at <= ? RETURNING id").all(identityId, now).length;
	}
	/** Hard-delete raw turns whose visitor deadline has passed (Q20). */
	purgeExpiredL0(now) {
		return this.db.prepare("DELETE FROM l0 WHERE purge_at IS NOT NULL AND purge_at <= ? RETURNING id").all(now).length;
	}
	/** Insert one fact and return its id. */
	insertFact(fact) {
		const now = fact.createdAt ?? Date.now();
		// Aliases ride in the same `tokens` column as the text, at the same
		// bm25 weight. A separate FTS column would need a migration and a
		// weight to argue about; the bigram index is already exactly the
		// thing a paraphrase has to hit.
		const aliases = aliasColumn(fact.aliases ?? [], fact.aliasLimit ?? 4);
		return asNumber$1(this.db.prepare(`
      INSERT INTO facts (
        identity_id, text, tokens, tags, kind, source, domain, subdomain, salience, base,
        stability, stability_max, access_count, last_access_at, created_at, updated_at,
        confidence, ttl, expires_at, due_from, expired_at, status, pinned, from_visitor, isolated,
        weight, source_ids, evidence, aliases
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(fact.identityId, fact.text, indexText(`${fact.text} ${(fact.tags ?? []).join(" ")} ${aliases}`), normalizeTags(fact.tags ?? []), fact.kind, fact.source, fact.domain, fact.subdomain ?? null, fact.salience, fact.base, fact.stability, fact.stabilityMax, now, now, now, fact.confidence, fact.ttl, fact.expiresAt, fact.dueFrom ?? null, fact.pinned === true ? 1 : 0, fact.fromVisitor === true ? 1 : 0, fact.isolated === true ? 1 : 0, fact.weight ?? 1, JSON.stringify(fact.sourceIds ?? []), JSON.stringify(fact.evidence ?? {}), aliases)["id"]);
	}
	/** Fetch one fact. */
	getFact(id) {
		const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id);
		return row === void 0 ? void 0 : factFrom(row);
	}
	/** Update the text-bearing columns of a fact after a merge, re-indexing FTS. */
	updateFactText(id, text, tags, salience, base, now) {
		// A merged fact keeps its aliases: the new wording usually refines the
		// old one, so the words the user would search by do not go stale.
		const row = this.db.prepare("SELECT aliases FROM facts WHERE id = ?").get(id);
		const aliases = typeof row?.["aliases"] === "string" ? row["aliases"] : "";
		this.db.prepare(`
      UPDATE facts SET text = ?, tokens = ?, tags = ?, salience = ?, base = ?, updated_at = ? WHERE id = ?
    `).run(text, indexText(`${text} ${tags.join(" ")} ${aliases}`), normalizeTags(tags), salience, base, now, id);
	}
	/**
	* Replace one fact's aliases and re-index it.
	*
	* Also the backfill path: a store that predates aliases keeps every fact,
	* and `memory_doctor` points here rather than leaving the gap silent.
	* @param id - fact id.
	* @param aliases - raw alias list; cleaned before storage.
	* @param now - write clock.
	* @param limit - how many to keep.
	* @returns whether the fact exists.
	*/
	updateFactAliases(id, aliases, now, limit = 4) {
		const row = this.db.prepare("SELECT text, tags FROM facts WHERE id = ?").get(id);
		if (row === void 0) return false;
		const stored = aliasColumn(aliases, limit);
		this.db.prepare("UPDATE facts SET aliases = ?, tokens = ?, updated_at = ? WHERE id = ?").run(stored, indexText(`${asString$1(row["text"])} ${asString$1(row["tags"])} ${stored}`), now, id);
		return true;
	}
	/**
	* Add aliases to a fact that already carries some.
	*
	* A merge keeps the old row, so the aliases collected on both sides stay
	* reachable: the first wording and the refined one rarely share vocabulary,
	* which is the whole reason the aliases exist.
	* @param id - fact id.
	* @param aliases - aliases to add.
	* @param now - write clock.
	* @param limit - how many to keep in total.
	* @returns whether the fact exists.
	*/
	addFactAliases(id, aliases, now, limit = 4) {
		const row = this.db.prepare("SELECT aliases FROM facts WHERE id = ?").get(id);
		if (row === void 0) return false;
		const before = asString$1(row["aliases"]).split(" ").filter((part) => part.length > 0);
		return this.updateFactAliases(id, [...before, ...(Array.isArray(aliases) ? aliases : [])], now, limit);
	}
	/**
	* Facts that carry no retrieval alias, most valuable first.
	*
	* Ordered by salience rather than id because the backlog is drained in
	* batches under a daily model budget: whatever the budget allows should be
	* spent on the rows someone is most likely to ask about.
	* @param identityId - whose facts.
	* @param limit - how many to fetch.
	* @returns id and text, nothing else — the caller only writes aliases back.
	*/
	factsMissingAliases(identityId, limit) {
		return this.db.prepare(`
      SELECT id, text FROM facts
      WHERE identity_id = ? AND status IN ('active','disputed') AND aliases = ''
      ORDER BY salience DESC, updated_at DESC LIMIT ?
    `).all(identityId, limit).map((row) => ({
			id: asNumber$1(row["id"]),
			text: asString$1(row["text"])
		}));
	}
	/** Update lifecycle columns. */
	updateFactState(id, patch) {
		const current = this.getFact(id);
		if (current === void 0) return;
		this.db.prepare(`
      UPDATE facts SET status = ?, superseded_by = ?, weight = ?, expires_at = ?, due_from = ?, ttl = ?, expired_at = ?,
        confidence = ?, pinned = ?, evidence = ?, updated_at = ? WHERE id = ?
    `).run(patch.status ?? current.status, patch.supersededBy ?? current.supersededBy, patch.weight ?? current.weight, patch.expiresAt === void 0 ? current.expiresAt : patch.expiresAt, patch.dueFrom === void 0 ? current.dueFrom : patch.dueFrom, patch.ttl ?? current.ttl, patch.expiredAt === void 0 ? current.expiredAt : patch.expiredAt, patch.confidence ?? current.confidence, patch.pinned ?? current.pinned ? 1 : 0, JSON.stringify(patch.evidence ?? current.evidence), patch.updatedAt ?? Date.now(), id);
	}
	/**
	* Re-date one fact.
	*
	* Kept separate from `updateFactState` because a new date is not a lifecycle
	* tweak: it revives an overdue plan (`expired_at` back to NULL), and it has to
	* move `due_from`, `expires_at` and `ttl` together or the window and the
	* window's start disagree and nothing says so.
	* @param id - fact id.
	* @param due - the resolved window.
	* @param now - write clock.
	* @param extraEvidence - fields to merge into `evidence`, e.g. clearing a pending proposal.
	*/
	updateFactDue(id, due, now, extraEvidence = {}) {
		const current = this.getFact(id);
		if (current === void 0) return;
		const evidence = {
			...current.evidence,
			...extraEvidence,
			ttlPhrase: due.phrase
		};
		// `pendingDue` is a proposal, not a fact: once a window is settled it
		// must not survive as a stale second date.
		delete evidence.pendingDue;
		this.db.prepare(`
      UPDATE facts SET due_from = ?, expires_at = ?, ttl = ?, expired_at = NULL, evidence = ?, updated_at = ? WHERE id = ?
    `).run(due.from, due.to, due.kind, JSON.stringify(evidence), now, id);
	}
	/** FTS search over one identity's facts. */
	searchFacts(identityId, match, limit, options = {}) {
		const closed = options.includeClosed === true ? "" : "AND f.status IN ('active','disputed')";
		const isolated = options.includeIsolated === true ? "" : "AND f.isolated = 0";
		return this.db.prepare(`
      SELECT f.*, bm25(facts_fts, 5.0, 1.0, 2.0) AS bm25
      FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
      WHERE facts_fts MATCH ? AND f.identity_id = ? ${closed} ${isolated}
      ORDER BY bm25 LIMIT ?
    `).all(match, identityId, limit).map((row) => ({
			...factFrom(row),
			bm25: asNumber$1(row["bm25"])
		}));
	}
	/** All visible facts of an identity (active, disputed and pending deletion). */
	factsForIdentity(identityId, limit = 200) {
		return this.db.prepare(`
      SELECT * FROM facts WHERE identity_id = ? AND status IN ('active','disputed','pending_delete')
      ORDER BY updated_at DESC LIMIT ?
    `).all(identityId, limit).map(factFrom);
	}
	/** Pinned facts are always rendered, budget permitting. */
	pinnedFacts(identityId) {
		return this.db.prepare(`
      SELECT * FROM facts WHERE identity_id = ? AND pinned = 1 AND status = 'active' ORDER BY updated_at DESC
    `).all(identityId).map(factFrom);
	}
	/** Recently updated facts, for cold-start recall. */
	recentFacts(identityId, limit) {
		return this.db.prepare(`
      SELECT * FROM facts WHERE identity_id = ? AND status IN ('active','disputed')
      ORDER BY updated_at DESC LIMIT ?
    `).all(identityId, limit).map(factFrom);
	}
	/**
	* Plans still ahead of us, soonest deadline first.
	*
	* A plan with no deadline sinks to the bottom. It cannot be late, so it has
	* no claim on the plan zone over one that can — but it is still a plan, and
	* dropping it would lose "我打算换工作" the moment the user stops mentioning it.
	*/
	openPlans(identityId, limit, now) {
		if (limit <= 0) return [];
		return this.db.prepare(`
      SELECT * FROM facts WHERE identity_id = ? AND kind = 'plan' AND status = 'active'
      AND resolved_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY expires_at IS NULL, expires_at ASC, created_at DESC LIMIT ?
    `).all(identityId, now, limit).map(factFrom);
	}
	/**
	* Plans whose deadline passed without being superseded.
	*
	* `expired_at` is set by maintenance for any TTL'd fact, plan or not, so the
	* second arm catches a plan that was stamped before the deadline check ran.
	* Resolved plans are excluded: they already have an answer, and re-asking a
	* question the user has answered is worse than not asking at all.
	*/
	overduePlans(identityId, limit, now) {
		if (limit <= 0) return [];
		return this.db.prepare(`
      SELECT * FROM facts WHERE identity_id = ? AND kind = 'plan' AND status = 'active'
      AND resolved_at IS NULL
      AND (expired_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?))
      -- Least recently asked first: never-asked rows sort at 0 and lead, then
      -- the ones whose turn has waited longest. Ordering by
      -- deadline put the newest first and starved everything past the cut.
      ORDER BY COALESCE(nudged_at, 0) ASC, expires_at ASC LIMIT ?
    `).all(identityId, now, limit).map(factFrom);
	}
	/**
	* Stamp the moment the block asked whether an overdue plan happened.
	*
	* Unconditional: this is the anchor of the re-ask interval, not a latch that
	* records "we have asked at some point". `AND nudged_at IS NULL` made the
	* second ask impossible — the first stamp froze the clock forever.
	*/
	markPlanNudged(id, now) {
		this.db.prepare("UPDATE facts SET nudged_at = ? WHERE id = ?").run(now, id);
	}
	/** Record the answer to that question; the plan stops being a live plan. */
	resolvePlan(id, outcome, now) {
		this.db.prepare("UPDATE facts SET resolved_at = ?, outcome = ?, updated_at = ? WHERE id = ?").run(now, outcome, now, id);
	}
	/**
	* Facts whose deadline went by and that maintenance should stamp as expired.
	*
	* Resolved plans are excluded, and that is not a micro-optimisation. A plan
	* that already has an outcome is a closed record, not a stale claim: the
	* date on it is when it was due, not a promise still waiting. Stamping it
	* would hand it to `expiryFactor` in `scoreFact` and start halving it in
	* search every `expiryHalfLifeDays` — the verbatim line "他说要去看房" would
	* fade out of reach precisely because the thing was dealt with. Sooner or
	* later `factsDueForPurge` would then delete the only copy of the promise,
	* which is the one thing `resolve()` deliberately does not overwrite.
	*
	* Cancelled plans land here too: they are usually resolved days before the
	* date they were given, so without this predicate every cancelled plan gets
	* stamped expired on its original date and quietly starts rotting.
	*/
	expireDueFacts(now) {
		return this.db.prepare(`
      SELECT * FROM facts WHERE expires_at IS NOT NULL AND expires_at <= ? AND expired_at IS NULL
      AND resolved_at IS NULL
      AND status IN ('active','disputed')
    `).all(now).map(factFrom);
	}
	/** Record one access: raise stability instead of resetting the clock (Q23). */
	markAccessed(id, now, stability, accessCount) {
		this.db.prepare("UPDATE facts SET stability = ?, access_count = ?, last_access_at = ? WHERE id = ?").run(stability, accessCount, now, id);
	}
	/** Delete one fact row (only after its grace period). */
	purgeFact(id) {
		const before = this.getFact(id);
		this.db.prepare("DELETE FROM facts WHERE id = ?").run(id);
		this.db.prepare("DELETE FROM memory_edges WHERE from_id = ? OR to_id = ?").run(id, id);
		this.db.prepare("DELETE FROM event_facts WHERE fact_id = ?").run(id);
		return before !== void 0;
	}
	/** Hard-delete every fact of an identity (friend deletion, Q62). */
	deleteFactsForIdentity(identityId) {
		/*
		* One row at a time through `purgeFact`, not a bare `DELETE FROM facts`:
		* that form leaves `memory_edges` and `event_facts` pointing at ids that no
		* longer exist, and the next contradiction scan reads those ids back.
		*/
		const ids = this.db.prepare("SELECT id FROM facts WHERE identity_id = ?").all(identityId).map((row) => asNumber$1(row["id"]));
		for (const id of ids) this.purgeFact(id);
		return ids.length;
	}
	/**
	* Delete the per-identity layers that do not live in `facts`.
	*
	* Erasing an identity used to stop at L0 and facts. The event summaries — the
	* closest thing in the store to the original wording — plus preferences,
	* diary, impression and persona overlay stayed, and `memory_expand` could
	* still read them back. The store promised "erase" and kept half of it.
	* `event_facts` follows the events through `ON DELETE CASCADE`.
	* @returns row counts per layer.
	*/
	purgeIdentityLayers(identityId) {
		/*
		* `changes`, not `RETURNING id`: `impressions` is keyed by identity_id and
		* has no `id` column, so a shared RETURNING clause cannot cover all five.
		*/
		const wipe = (sql) => Number(this.db.prepare(sql).run(identityId).changes);
		return {
			events: wipe("DELETE FROM events WHERE identity_id = ?"),
			preferences: wipe("DELETE FROM preferences WHERE identity_id = ?"),
			diary: wipe("DELETE FROM diary WHERE identity_id = ?"),
			impressions: wipe("DELETE FROM impressions WHERE identity_id = ?"),
			overlays: wipe("DELETE FROM persona_overlays WHERE identity_id = ?")
		};
	}
	/** Facts past their deletion grace period. */
	factsDueForPurge(now) {
		return this.db.prepare(`
      SELECT id FROM facts WHERE status = 'pending_delete' AND updated_at <= ?
    `).all(now).map((row) => asNumber$1(row["id"]));
	}
	/** Count active facts of an identity. */
	countFacts(identityId) {
		return asNumber$1(this.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE identity_id = ? AND status IN ('active','disputed')").get(identityId)["n"]);
	}
	/** Insert one episode and its links. */
	insertEvent(event, factIds) {
		const createdAt = event.createdAt ?? Date.now();
		const aliases = aliasColumn(event.aliases ?? [], event.aliasLimit ?? 3);
		const id = asNumber$1(this.db.prepare(`
      INSERT INTO events (
        identity_id, session_id, title, summary, tokens, domain, started_at, ended_at,
        turn_from, turn_to, salience, valence, arousal, l0_from, l0_to, created_at, aliases
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(event.identityId, event.sessionId, event.title, event.summary, indexText(`${event.title} ${event.summary} ${aliases}`), event.domain, event.startedAt, event.endedAt, event.turnFrom, event.turnTo, event.salience, event.valence, event.arousal, event.l0From, event.l0To, createdAt, aliases)["id"]);
		const link = this.db.prepare("INSERT OR IGNORE INTO event_facts (event_id, fact_id) VALUES (?, ?)");
		for (const factId of factIds) link.run(id, factId);
		return id;
	}
	/** FTS search over episodes. */
	searchEvents(identityId, match, limit) {
		return this.db.prepare(`
      SELECT e.*, bm25(events_fts, 5.0, 1.0, 1.0) AS bm25
      FROM events_fts JOIN events e ON e.id = events_fts.rowid
      WHERE events_fts MATCH ? AND e.identity_id = ? AND e.status = 'active'
      ORDER BY bm25 LIMIT ?
    `).all(match, identityId, limit).map((row) => ({
			...eventFrom(row),
			bm25: asNumber$1(row["bm25"])
		}));
	}
	/** Recent episodes. */
	recentEvents(identityId, limit) {
		return this.db.prepare(`
      SELECT * FROM events WHERE identity_id = ? AND status = 'active' ORDER BY ended_at DESC LIMIT ?
    `).all(identityId, limit).map(eventFrom);
	}
	/** Fact ids attached to one episode. */
	eventFactIds(eventId) {
		return this.db.prepare("SELECT fact_id FROM event_facts WHERE event_id = ?").all(eventId).map((row) => asNumber$1(row["fact_id"]));
	}
	/** Lengths of the most recent episodes, oldest first, for the dynamic bound. */
	recentEventLengths(identityId, limit) {
		return this.db.prepare(`
      SELECT (turn_to - turn_from + 1) AS turns FROM events WHERE identity_id = ?
      ORDER BY ended_at DESC LIMIT ?
    `).all(identityId, limit).reverse().map((row) => asNumber$1(row["turns"], 1));
	}
	/** The current self-narrative, if any. */
	currentNarrative() {
		const row = this.db.prepare("SELECT * FROM narrative WHERE archived = 0 ORDER BY version DESC LIMIT 1").get();
		return row === void 0 ? void 0 : narrativeFrom(row);
	}
	/** Store a new narrative version and keep only the latest `keep` archived snapshots. */
	insertNarrative(text, evidenceCount, now, keep = 3) {
		const version = asNumber$1(this.db.prepare("SELECT MAX(version) AS v FROM narrative").get()["v"]) + 1;
		this.db.prepare("UPDATE narrative SET archived = 1 WHERE archived = 0").run();
		this.db.prepare("INSERT INTO narrative (version, text, evidence_count, created_at, archived) VALUES (?, ?, ?, ?, 0)").run(version, text, evidenceCount, now);
		const stale = this.db.prepare("SELECT id FROM narrative WHERE archived = 1 ORDER BY version DESC LIMIT -1 OFFSET ?").all(keep);
		for (const row of stale) this.db.prepare("DELETE FROM narrative WHERE id = ?").run(asNumber$1(row["id"]));
		return this.currentNarrative();
	}
	/** The assistant's current impression of one partner. */
	getImpression(identityId) {
		const row = this.db.prepare("SELECT * FROM impressions WHERE identity_id = ?").get(identityId);
		if (row === void 0) return void 0;
		return {
			identityId,
			text: asString$1(row["text"]),
			confidence: asNumber$1(row["confidence"], .5),
			observations: asNumber$1(row["observations"], 1),
			updatedAt: asNumber$1(row["updated_at"])
		};
	}
	/** Insert or replace the impression of one partner. */
	upsertImpression(identityId, text, confidence, observations, now) {
		this.db.prepare(`
      INSERT INTO impressions (identity_id, text, confidence, observations, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(identity_id) DO UPDATE SET text = excluded.text, confidence = excluded.confidence,
        observations = excluded.observations, updated_at = excluded.updated_at
    `).run(identityId, text, confidence, observations, now);
	}
	/** Diary entries written on a given local day. */
	countDiaryOn(identityId, dayKey$1) {
		return asNumber$1(this.db.prepare("SELECT COUNT(*) AS n FROM diary WHERE identity_id = ? AND day_key = ?").get(identityId, dayKey$1)["n"]);
	}
	/** Every diary entry this identity has, for the profile counter. */
	countDiary(identityId) {
		return asNumber$1(this.db.prepare("SELECT COUNT(*) AS n FROM diary WHERE identity_id = ?").get(identityId)["n"]);
	}
	/** Add one diary entry. */
	addDiary(identityId, entry, dayKey$1, now) {
		return asNumber$1(this.db.prepare(`
      INSERT INTO diary (identity_id, entry, day_key, created_at) VALUES (?, ?, ?, ?) RETURNING id
    `).get(identityId, entry, dayKey$1, now)["id"]);
	}
	/** Recent diary entries for one identity. */
	recentDiary(identityId, limit) {
		return this.db.prepare("SELECT * FROM diary WHERE identity_id = ? ORDER BY created_at DESC LIMIT ?").all(identityId, limit).map((row) => ({
			id: asNumber$1(row["id"]),
			identityId,
			entry: asString$1(row["entry"]),
			dayKey: asString$1(row["day_key"]),
			createdAt: asNumber$1(row["created_at"])
		}));
	}
	/** One day's entries across identities, oldest first, with the name to print. */
	diaryOnDay(dayKey$1) {
		return this.db.prepare(`
      SELECT d.id, d.entry, d.created_at, COALESCE(i.name, d.identity_id) AS name
      FROM diary d LEFT JOIN identities i ON i.id = d.identity_id
      WHERE d.day_key = ? ORDER BY d.created_at ASC
    `).all(dayKey$1).map((row) => ({
			id: asNumber$1(row["id"]),
			entry: asString$1(row["entry"]),
			createdAt: asNumber$1(row["created_at"]),
			name: asString$1(row["name"])
		}));
	}
	/** The most recent days that actually have entries, newest first. */
	recentDiaryDays(limit) {
		return this.db.prepare("SELECT day_key FROM diary GROUP BY day_key ORDER BY day_key DESC LIMIT ?").all(limit).map((row) => asString$1(row["day_key"])).filter((key) => key.length > 0);
	}
	/** Statements stored in the isolated preference zone (Q44). */
	insertPreference(identityId, text, sourceL0, now) {
		return asNumber$1(this.db.prepare(`
      INSERT INTO preferences (identity_id, text, tokens, source_l0, created_at, active) VALUES (?, ?, ?, ?, ?, 1) RETURNING id
    `).get(identityId, text, indexText(text), sourceL0, now)["id"]);
	}
	/**
	* Search the preference zone for the current query.
	*
	* `created_at` is selected because `memory_search` prints a date in front of
	* every line, and a preference with a placeholder date would be the one row
	* class whose line lies. The recall path ignores the extra field.
	*/
	searchPreferences(identityId, match, limit) {
		return this.db.prepare(`
      SELECT p.id, p.text, p.created_at, bm25(preferences_fts, 5.0, 1.0) AS bm25
      FROM preferences_fts JOIN preferences p ON p.id = preferences_fts.rowid
      WHERE preferences_fts MATCH ? AND p.identity_id = ? AND p.active = 1
      ORDER BY bm25 LIMIT ?
    `).all(match, identityId, limit).map((row) => ({
			id: asNumber$1(row["id"]),
			text: asString$1(row["text"]),
			createdAt: asNumber$1(row["created_at"]),
			bm25: asNumber$1(row["bm25"])
		}));
	}
	/** One standing preference, including retired rows (callers decide what a retired row means). */
	getPreference(id) {
		const row = this.db.prepare("SELECT id, identity_id, text, active, created_at FROM preferences WHERE id = ?").get(id);
		if (row === void 0) return void 0;
		return {
			id: asNumber$1(row["id"]),
			identityId: asString$1(row["identity_id"]),
			text: asString$1(row["text"]),
			active: asBoolean(row["active"]),
			createdAt: asNumber$1(row["created_at"])
		};
	}
	/**
	* Retire a standing preference.
	*
	* Soft by default: the row stays (the user may change their mind, and the
	* audit trail is how we can say when a rule stopped applying), but `active = 0`
	* takes it out of the resident zone and out of every FTS read. Nothing wrote
	* this column before, which is why "以后别管我那条规矩了" had no effect at all.
	*/
	retirePreference(id) {
		this.db.prepare("UPDATE preferences SET active = 0 WHERE id = ?").run(id);
	}
	/** Delete a preference row outright; the FTS triggers keep the index in step. */
	purgePreference(id) {
		this.db.prepare("DELETE FROM preferences WHERE id = ?").run(id);
	}
	/**
	* The most recent standing preferences of an identity.
	*
	* Preferences had no resident path: they were only reachable through a
	* `preferences_fts MATCH` that ANDs every CJK bigram of the user's sentence,
	* so a long sentence almost never recalled one. "我不吃香菜" therefore
	* vanished whenever the current message did not share most of its bigrams.
	* Recent entries are now always offered to recall, the way pinned facts are.
	*/
	recentPreferences(identityId, limit) {
		return this.db.prepare(`
      SELECT id, text FROM preferences WHERE identity_id = ? AND active = 1
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(identityId, limit).map((row) => ({
			id: asNumber$1(row["id"]),
			text: asString$1(row["text"])
		}));
	}
	/**
	* Every standing instruction's text, for duplicate detection.
	*
	* Instructions live in their own table, so a duplicate check that only looks
	* at `facts` will re-add them on every import — the one row class that would
	* grow a copy per run.
	*
	* Retired rows are included on purpose. A source file cannot know that the
	* user later said「这条不用管了」, so filtering them out here would let any
	* import put a cancelled rule back into the resident zone — the same
	* resurrection `intakeRowRetired` blocks from the other side. Bringing a
	* retired rule back is `memory_write`'s job (the user saying it again), not
	* a side effect of importing a file.
	* @param identityId - whose instructions.
	* @returns the stored texts, retired ones included.
	*/
	preferenceTexts(identityId) {
		return this.db.prepare("SELECT text FROM preferences WHERE identity_id = ?").all(identityId).map((row) => asString$1(row["text"]));
	}
	/** Every persona zone, ordered by a stable presentation order. */
	personaZones() {
		return this.db.prepare("SELECT * FROM persona_zones ORDER BY zone ASC").all().map((row) => ({
			zone: asString$1(row["zone"]),
			text: asString$1(row["text"]),
			editableBy: asString$1(row["editable_by"], "both"),
			locked: asBoolean(row["locked"]),
			updatedAt: asNumber$1(row["updated_at"]),
			source: asString$1(row["source"])
		}));
	}
	/** One persona zone. */
	personaZone(zone) {
		return this.personaZones().find((candidate) => candidate.zone === zone);
	}
	/** Insert or replace a persona zone. */
	upsertPersonaZone(zone) {
		this.db.prepare(`
      INSERT INTO persona_zones (zone, text, editable_by, locked, updated_at, source) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(zone) DO UPDATE SET text = excluded.text, editable_by = excluded.editable_by,
        locked = excluded.locked, updated_at = excluded.updated_at, source = excluded.source
    `).run(zone.zone, zone.text, zone.editableBy, zone.locked ? 1 : 0, zone.updatedAt, zone.source);
	}
	/** Set the lock flag of a zone. */
	setPersonaLock(zone, locked, now) {
		this.db.prepare("UPDATE persona_zones SET locked = ?, updated_at = ? WHERE zone = ?").run(locked ? 1 : 0, now, zone);
	}
	/** Overlays of one identity. */
	personaOverlays(identityId) {
		return this.db.prepare("SELECT * FROM persona_overlays WHERE identity_id = ?").all(identityId).map((row) => ({
			identityId,
			zone: asString$1(row["zone"]),
			text: asString$1(row["text"]),
			updatedAt: asNumber$1(row["updated_at"])
		}));
	}
	/** Insert or replace an overlay. */
	upsertPersonaOverlay(identityId, zone, text, now) {
		this.db.prepare(`
      INSERT INTO persona_overlays (identity_id, zone, text, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(identity_id, zone) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
    `).run(identityId, zone, text, now);
	}
	/** Record a persona change for auditability (Q13/Q16). */
	addPersonaHistory(zone, oldText, newText, source, actor, now) {
		this.db.prepare("INSERT INTO persona_history (zone, old_text, new_text, source, actor, at) VALUES (?, ?, ?, ?, ?, ?)").run(zone, oldText, newText, source, actor, now);
	}
	/** Persona change history, newest first. */
	personaHistory(limit = 50) {
		return this.db.prepare("SELECT * FROM persona_history ORDER BY at DESC LIMIT ?").all(limit).map((row) => ({
			id: asNumber$1(row["id"]),
			zone: asString$1(row["zone"]),
			oldText: asString$1(row["old_text"]),
			newText: asString$1(row["new_text"]),
			source: asString$1(row["source"]),
			actor: asString$1(row["actor"]),
			at: asNumber$1(row["at"])
		}));
	}
	/** Enqueue a self-claimed identity (Q61). */
	insertClaim(input) {
		return asNumber$1(this.db.prepare(`
      INSERT INTO identity_claims (claimant_session, claimant_identity, claimed_identity, display_name, platform, platform_user_id, evidence, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id
    `).get(input.claimantSession, input.claimantIdentity, input.claimedIdentity, input.displayName, input.platform, input.platformUserId, input.evidence, input.now)["id"]);
	}
	/** Claims, newest first, optionally filtered by status. */
	claims(status) {
		return (status === void 0 ? this.db.prepare("SELECT * FROM identity_claims ORDER BY created_at DESC").all() : this.db.prepare("SELECT * FROM identity_claims WHERE status = ? ORDER BY created_at DESC").all(status)).map((row) => ({
			id: asNumber$1(row["id"]),
			claimantSession: asString$1(row["claimant_session"]),
			claimantIdentity: asString$1(row["claimant_identity"]),
			claimedIdentity: typeof row["claimed_identity"] === "string" ? row["claimed_identity"] : null,
			displayName: asString$1(row["display_name"]),
			platform: typeof row["platform"] === "string" ? row["platform"] : null,
			platformUserId: typeof row["platform_user_id"] === "string" ? row["platform_user_id"] : null,
			evidence: asString$1(row["evidence"]),
			status: asString$1(row["status"], "pending"),
			createdAt: asNumber$1(row["created_at"]),
			reviewedAt: asNullableNumber(row["reviewed_at"]),
			reviewNote: typeof row["review_note"] === "string" ? row["review_note"] : null
		}));
	}
	/** The pending claim of one session, if any. */
	pendingClaimForSession(sessionId) {
		return this.claims("pending").find((claim) => claim.claimantSession === sessionId);
	}
	/** Apply the master's verdict to one claim. */
	reviewClaim(id, approved, note, now) {
		this.db.prepare("UPDATE identity_claims SET status = ?, reviewed_at = ?, review_note = ? WHERE id = ?").run(approved ? "approved" : "rejected", now, note, id);
	}
	/** Add a typed edge between two facts. */
	addEdge(fromId, toId, edgeType, now) {
		this.db.prepare("INSERT OR IGNORE INTO memory_edges (from_id, to_id, edge_type, created_at) VALUES (?, ?, ?, ?)").run(fromId, toId, edgeType, now);
	}
	/** Edges around one fact. */
	edgesFor(factId) {
		return this.db.prepare("SELECT * FROM memory_edges WHERE from_id = ? OR to_id = ?").all(factId, factId).map((row) => ({
			fromId: asNumber$1(row["from_id"]),
			toId: asNumber$1(row["to_id"]),
			edgeType: asString$1(row["edge_type"])
		}));
	}
	/** Enqueue a job; a duplicate dedupe key keeps the existing row. */
	enqueueJob(kind, payload, dedupeKey, now, nextAt = now) {
		try {
			return asNumber$1(this.db.prepare(`
        INSERT INTO jobs (kind, payload, status, attempts, next_at, created_at, updated_at, dedupe_key)
        VALUES (?, ?, 'pending', 0, ?, ?, ?, ?) RETURNING id
      `).get(kind, JSON.stringify(payload), nextAt, now, now, dedupeKey)["id"]);
		} catch {
			return;
		}
	}
	/** Jobs that are due. */
	dueJobs(now, limit = 20) {
		return this.db.prepare("SELECT * FROM jobs WHERE status = 'pending' AND next_at <= ? ORDER BY next_at ASC LIMIT ?").all(now, limit).map((row) => ({
			id: asNumber$1(row["id"]),
			kind: asString$1(row["kind"]),
			payload: parseJson(row["payload"], {}),
			status: asString$1(row["status"], "pending"),
			attempts: asNumber$1(row["attempts"]),
			lastError: typeof row["last_error"] === "string" ? row["last_error"] : null,
			nextAt: asNumber$1(row["next_at"]),
			createdAt: asNumber$1(row["created_at"]),
			updatedAt: asNumber$1(row["updated_at"]),
			dedupeKey: typeof row["dedupe_key"] === "string" ? row["dedupe_key"] : null
		}));
	}
	/** Update a job's status and schedule. */
	updateJob(id, patch, now) {
		const current = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
		if (current === void 0) return;
		this.db.prepare("UPDATE jobs SET status = ?, attempts = ?, last_error = ?, next_at = ?, updated_at = ? WHERE id = ?").run(patch.status ?? asString$1(current["status"], "pending"), patch.attempts ?? asNumber$1(current["attempts"]), patch.lastError === void 0 ? typeof current["last_error"] === "string" ? current["last_error"] : null : patch.lastError, patch.nextAt ?? asNumber$1(current["next_at"]), now, id);
	}
	/** Record a failure that will not be retried automatically; it stays visible in the dead-letter list. */
	deadLetter(kind, payload, error, now, dedupeKey = null) {
		try {
			this.db.prepare(`
        INSERT INTO jobs (kind, payload, status, attempts, last_error, next_at, created_at, updated_at, dedupe_key)
        VALUES (?, ?, 'dead', 0, ?, ?, ?, ?, ?)
      `).run(kind, JSON.stringify(payload), error, now, now, now, dedupeKey);
		} catch {}
	}
	/** Count dead-lettered jobs. */
	deadJobCount() {
		return asNumber$1(this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'dead'").get()["n"]);
	}
	/** Oldest dead job timestamp. */
	oldestDeadJobAt() {
		return asNullableNumber(this.db.prepare("SELECT MIN(created_at) AS t FROM jobs WHERE status = 'dead'").get()["t"]);
	}
	/** Append one audit record. */
	audit(actor, action, entity, entityId, detail, now) {
		this.db.prepare("INSERT INTO audit (at, actor, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)").run(now, actor, action, entity, entityId, JSON.stringify(detail));
	}
	/** Recent audit records. */
	auditRecords(limit = 50) {
		return this.db.prepare("SELECT * FROM audit ORDER BY at DESC LIMIT ?").all(limit).map((row) => ({
			id: asNumber$1(row["id"]),
			at: asNumber$1(row["at"]),
			actor: asString$1(row["actor"]),
			action: asString$1(row["action"]),
			entity: asString$1(row["entity"]),
			entityId: typeof row["entity_id"] === "string" ? row["entity_id"] : null,
			detail: parseJson(row["detail"], {})
		}));
	}
	/** Count model calls made for an identity on a local day. */
	dailyCalls(identityId, day) {
		const row = this.db.prepare("SELECT calls FROM usage_daily WHERE identity_id = ? AND day = ?").get(identityId, day);
		return row === void 0 ? 0 : asNumber$1(row["calls"]);
	}
	/** Add one model call to the daily counter. */
	addUsage(identityId, day, calls, inputTokens, outputTokens) {
		this.db.prepare(`
      INSERT INTO usage_daily (identity_id, day, calls, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(identity_id, day) DO UPDATE SET calls = calls + excluded.calls,
        input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens
    `).run(identityId, day, calls, inputTokens, outputTokens);
	}
	/** Append a redacted trace: ids, scores and channels only, never memory text (Q51). */
	trace(entry) {
		this.db.prepare("INSERT INTO traces (at, session_id, operation, channel, detail, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)").run(entry.at, entry.sessionId, entry.operation, entry.channel, JSON.stringify(entry.detail), entry.durationMs, entry.error);
	}
	/** Delete traces older than the retention window (Q51: 14 days). */
	pruneTraces(before) {
		return this.db.prepare("DELETE FROM traces WHERE at < ? RETURNING id").all(before).length;
	}
	/** Recent traces for diagnostics. */
	traces(limit = 50) {
		return this.db.prepare("SELECT * FROM traces ORDER BY at DESC LIMIT ?").all(limit).map((row) => ({
			id: asNumber$1(row["id"]),
			at: asNumber$1(row["at"]),
			operation: asString$1(row["operation"]),
			channel: typeof row["channel"] === "string" ? row["channel"] : null,
			detail: parseJson(row["detail"], {}),
			durationMs: asNullableNumber(row["duration_ms"]),
			error: typeof row["error"] === "string" ? row["error"] : null
		}));
	}
};

//#endregion
//#region src/engine/decay.ts
/**
* The multiplicative strength of a memory.
* @param input - base, stability, age and exponent.
* @returns `base · (1 + t/S)^(−d)`.
*/
function strength({ base, stability, ageDays: ageDays$1, d }) {
	const safeStability = Math.max(stability, 1e-6);
	const safeAge = Math.max(ageDays$1, 0);
	return base * Math.pow(1 + safeAge / safeStability, -d);
}
/**
* Stability after an access. Growth slows as `S` grows, and the result never
* exceeds `sMax`.
* @param stability - current `S` in days.
* @param boost - growth coefficient (0 disables growth).
* @param sMax - hard cap, typically `sInitial × 50`.
* @returns the new `S`.
*/
function boostedStability(stability, boost, sMax) {
	if (boost <= 0) return Math.min(stability, sMax);
	const grown = stability * (1 + boost * Math.pow(Math.max(stability, 1e-6), -.2));
	return Math.min(Math.max(grown, stability), sMax);
}
/**
* Continuous penalty for a soft-expired memory (Q11). It starts at 1 on the
* expiry instant and halves every `halfLifeDays`, never dropping below the
* global floor.
* @param daysSinceExpiry - age since `expired_at`, in days.
* @param halfLifeDays - half-life of the penalty, default 45.
* @param floor - score floor, default 0.02.
* @returns a multiplier in [floor, 1].
*/
function expiryFactor(daysSinceExpiry, halfLifeDays, floor) {
	if (!Number.isFinite(daysSinceExpiry) || daysSinceExpiry < 0) return 1;
	const raw = Math.pow(.5, daysSinceExpiry / Math.max(halfLifeDays, 1e-6));
	return Math.max(raw, floor);
}
/**
* Couple the emotional salience of a memory to its base strength (Q23): a
* neutral memory keeps 0.55, a maximally salient one reaches 1.0.
* @param salience - emotional salience in [0,1].
* @returns the base strength.
*/
function baseFromSalience(salience) {
	return Math.min(1, Math.max(.5, .55 + .45 * clamp01(salience)));
}
/**
* Final score of one candidate, following the layered combination of Q56:
* strength (similarity × decay × base) multiplies; emotion and the layer-cost
* penalty add; soft expiry and a possible conflict multiply afterwards; the
* floor applies last.
* @param parts - the score parts, all already normalized.
* @returns a score clamped to [floor, ∞).
*/
function finalScore(parts) {
	const scaled = (parts.similarity * parts.strength + parts.emotion + parts.layerPenalty) * parts.expiryFactor * parts.conflictFactor;
	return Math.max(parts.floor, Number.isFinite(scaled) ? scaled : parts.floor);
}
/** Clamp a number to [0,1]. */
function clamp01(value) {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}
/** Age of a memory in days, never negative. */
function ageDays(now, since) {
	return Math.max(0, (now - since) / 864e5);
}

//#endregion
//#region src/engine/domain.ts
/** Human labels used when rendering. */
const DOMAIN_LABELS = {
	work: {
		zh: "工作",
		en: "work"
	},
	study: {
		zh: "学习",
		en: "study"
	},
	life: {
		zh: "日常",
		en: "daily life"
	},
	relationship: {
		zh: "情感",
		en: "relationships"
	},
	family: {
		zh: "家庭",
		en: "family"
	},
	health: {
		zh: "健康",
		en: "health"
	},
	money: {
		zh: "财务",
		en: "money"
	},
	travel: {
		zh: "出行",
		en: "travel"
	},
	leisure: {
		zh: "娱乐",
		en: "leisure"
	},
	tech: {
		zh: "技术",
		en: "technology"
	},
	other: {
		zh: "其他",
		en: "other"
	}
};
const LEXICON = {
	work: [
		"工作",
		"项目",
		"会议",
		"同事",
		"老板",
		"领导",
		"加班",
		"客户",
		"汇报",
		"面试",
		"offer",
		"辞职",
		"公司",
		"部门",
		"deadline",
		"project",
		"meeting",
		"manager",
		"colleague",
		"client",
		"boss"
	],
	study: [
		"学习",
		"考试",
		"课程",
		"论文",
		"作业",
		"老师",
		"同学",
		"复习",
		"毕业",
		"学校",
		"专业",
		"读书",
		"考试",
		"study",
		"exam",
		"course",
		"paper",
		"school",
		"class",
		"thesis"
	],
	life: [
		"起床",
		"睡觉",
		"吃饭",
		"做饭",
		"买菜",
		"打扫",
		"房租",
		"快递",
		"洗澡",
		"散步",
		"周末",
		"日常",
		"睡",
		"吃",
		"生活",
		"sleep",
		"eat",
		"cook",
		"clean",
		"weekend",
		"groceries"
	],
	relationship: [
		"分手",
		"吵架",
		"想念",
		"约会",
		"男朋友",
		"女朋友",
		"恋爱",
		"表白",
		"暧昧",
		"伴侣",
		"婚姻",
		"感情",
		"心动",
		"喜欢的人",
		"date",
		"boyfriend",
		"girlfriend",
		"breakup",
		"miss you",
		"crush"
	],
	family: [
		"妈妈",
		"爸爸",
		"父母",
		"孩子",
		"儿子",
		"女儿",
		"爷爷",
		"奶奶",
		"家里",
		"亲戚",
		"姐姐",
		"妹妹",
		"哥哥",
		"弟弟",
		"mother",
		"father",
		"parents",
		"daughter",
		"son",
		"family"
	],
	health: [
		"生病",
		"医院",
		"医生",
		"吃药",
		"头疼",
		"发烧",
		"感冒",
		"失眠",
		"体检",
		"手术",
		"焦虑",
		"抑郁",
		"健康",
		"sick",
		"doctor",
		"hospital",
		"medicine",
		"fever",
		"anxiety",
		"health"
	],
	money: [
		"钱",
		"工资",
		"存款",
		"投资",
		"股票",
		"基金",
		"房贷",
		"账单",
		"花销",
		"省钱",
		"买",
		"预算",
		"salary",
		"money",
		"invest",
		"stock",
		"rent",
		"bill",
		"budget",
		"save"
	],
	travel: [
		"旅行",
		"出差",
		"飞机",
		"高铁",
		"酒店",
		"机票",
		"签证",
		"旅游",
		"车站",
		"机场",
		"假期",
		"trip",
		"flight",
		"hotel",
		"train",
		"visa",
		"travel",
		"airport"
	],
	leisure: [
		"电影",
		"游戏",
		"音乐",
		"小说",
		"追剧",
		"综艺",
		"演唱会",
		"运动",
		"健身",
		"画画",
		"摄影",
		"movie",
		"game",
		"music",
		"novel",
		"series",
		"concert",
		"gym",
		"hiking"
	],
	tech: [
		"代码",
		"程序",
		"bug",
		"服务器",
		"数据库",
		"部署",
		"模型",
		"ai",
		"接口",
		"版本",
		"编译",
		"code",
		"program",
		"server",
		"database",
		"deploy",
		"model",
		"api",
		"build",
		"typescript",
		"python"
	]
};
/**
* Detect the top-level domain of a passage by lexicon hits.
* @param text - any text, usually a turn or an event summary.
* @returns the strongest domain, or `other` when nothing matches.
*/
function detectDomain(text) {
	const lower = text.toLowerCase();
	const scores = /* @__PURE__ */ new Map();
	let total = 0;
	for (const [domain, words] of Object.entries(LEXICON)) {
		const hits = [];
		for (const word of words) if (lower.includes(word)) {
			hits.push(word);
			total++;
		}
		if (hits.length > 0) scores.set(domain, {
			count: hits.length,
			hits
		});
	}
	let best = "other";
	let bestCount = 0;
	let bestHits = [];
	for (const [domain, { count, hits }] of scores) if (count > bestCount) {
		best = domain;
		bestCount = count;
		bestHits = hits;
	}
	return {
		domain: best,
		confidence: total === 0 ? 0 : bestCount / total,
		hits: bestHits
	};
}

//#endregion
//#region src/engine/salience.ts
const POSITIVE = [
	"喜欢",
	"爱",
	"开心",
	"高兴",
	"幸福",
	"谢谢",
	"感谢",
	"太好了",
	"棒",
	"满意",
	"放心",
	"期待",
	"感动",
	"骄傲",
	"哈哈",
	"笑",
	"温柔",
	"可爱",
	"舒服",
	"安心",
	"love",
	"happy",
	"glad",
	"great",
	"thanks",
	"thank you",
	"excited",
	"proud",
	"wonderful",
	"amazing",
	"cute"
];
const NEGATIVE = [
	"讨厌",
	"恨",
	"难过",
	"伤心",
	"生气",
	"愤怒",
	"害怕",
	"担心",
	"焦虑",
	"痛苦",
	"失望",
	"委屈",
	"烦",
	"累",
	"崩溃",
	"孤独",
	"后悔",
	"羞",
	"尴尬",
	"不行",
	"糟糕",
	"讨厌",
	"hate",
	"sad",
	"angry",
	"afraid",
	"scared",
	"worried",
	"anxious",
	"tired",
	"exhausted",
	"upset",
	"lonely",
	"sorry"
];
const INTENSIFIERS = [
	"非常",
	"特别",
	"十分",
	"极其",
	"真的",
	"太",
	"超",
	"最",
	"死",
	"巨",
	"超级",
	"极其",
	"好想",
	"really",
	"very",
	"extremely",
	"so",
	"totally",
	"absolutely"
];
const INTIMACY = [
	"我",
	"你",
	"我们",
	"一起",
	"陪",
	"答应",
	"秘密",
	"只有你",
	"别告诉",
	"第一次",
	"永远",
	"一直",
	"i ",
	"you",
	"we ",
	"us ",
	"secret",
	"promise",
	"always",
	"never"
];
/** Count case-insensitive occurrences of any phrase. */
function countHits(text, phrases) {
	let hits = 0;
	for (const phrase of phrases) {
		let from = 0;
		while (true) {
			const at = text.indexOf(phrase, from);
			if (at < 0) break;
			hits++;
			from = at + phrase.length;
		}
	}
	return hits;
}
/**
* Score the emotional charge of a passage with rules alone.
* @param text - the passage, usually one turn of the conversation.
* @returns salience plus valence/arousal, all bounded.
*/
function readEmotion(text) {
	if (text.trim().length === 0) return {
		salience: 0,
		valence: 0,
		arousal: 0,
		cues: []
	};
	const lower = text.toLowerCase();
	const positive = countHits(lower, POSITIVE);
	const negative = countHits(lower, NEGATIVE);
	const intense = countHits(lower, INTENSIFIERS);
	const intimate = countHits(lower, INTIMACY);
	const exclamations = (text.match(/[!！]/gu) ?? []).length;
	const questions = (text.match(/[?？]/gu) ?? []).length;
	const repeats = /([!！?？。])\1{1,}/u.test(text) ? 1 : 0;
	const lengthFactor = Math.min(1, text.length / 220);
	const emotional = positive + negative;
	const valenceRaw = positive - negative;
	const valence = emotional === 0 ? 0 : Math.max(-1, Math.min(1, valenceRaw / Math.max(2, emotional)));
	const arousal = Math.min(1, exclamations * .18 + intense * .12 + repeats * .1 + emotional * .1 + questions * .02);
	let salience = .08;
	salience += Math.min(.42, emotional * .14);
	salience += Math.min(.18, intense * .06);
	salience += Math.min(.12, exclamations * .04);
	salience += repeats * .05;
	salience += Math.min(.1, intimate * .02);
	salience += lengthFactor * .05;
	salience += Math.abs(valence) * .12;
	salience = Math.max(0, Math.min(1, salience));
	const cues = [];
	if (positive > 0) cues.push("positive");
	if (negative > 0) cues.push("negative");
	if (intense > 0) cues.push("intensifier");
	if (intimate > 0) cues.push("intimacy");
	if (exclamations > 0 || repeats > 0) cues.push("punct");
	return {
		salience,
		valence,
		arousal,
		cues
	};
}
/**
* Combine a rule reading with a model reading. The model wins on salience
* when it is present, but the rule value still smooths extreme swings.
* @param rule - the online reading.
* @param model - the offline reading, when the consolidation call produced one.
* @returns the reading consolidation stores.
*/
function blendEmotion(rule, model) {
	if (model === void 0 || model.salience === void 0) return rule;
	return {
		salience: Math.max(0, Math.min(1, model.salience * .75 + rule.salience * .25)),
		valence: Math.max(-1, Math.min(1, model.valence ?? rule.valence)),
		arousal: Math.max(0, Math.min(1, model.arousal ?? rule.arousal)),
		cues: [...new Set([...rule.cues, "model"])]
	};
}

//#endregion
//#region src/engine/segment.ts
/** Median of a numeric list; 0 for an empty list. */
function median(values) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
/**
* Choose the dynamic bound `N` for this pass (Q7/Q8).
* @param context - recent segment lengths and the sample counter.
* @param config - segmentation knobs.
* @returns the bound and whether its sample was large enough to trust.
*/
function dynamicBound(context, config) {
	const recent = (context.recentSegmentTurns ?? []).slice(-(context.sampleK ?? 20));
	const totalTurns = context.totalTurnsSoFar ?? 0;
	const sampleM = context.sampleM ?? 100;
	const sampleInsufficient = totalTurns < sampleM || recent.length < 3;
	const raw = median(recent);
	const bound = Math.max(config.minSecondary, Math.round(raw > 0 ? raw : config.minSecondary));
	return {
		bound,
		sampleInsufficient,
		reason: sampleInsufficient ? `样本不足（${totalTurns}/${sampleM} 轮），使用下限 ${config.minSecondary}` : `近期事件中位数 ${raw.toFixed(1)} 轮，取 ${bound}`
	};
}
function makeSegment(units, fromIndex, toIndex, reason, secondary) {
	const first = units[fromIndex];
	const last = units[toIndex];
	let salience = 0;
	let valenceSum = 0;
	let arousalSum = 0;
	const domains = /* @__PURE__ */ new Map();
	const texts = [];
	for (let index = fromIndex; index <= toIndex; index++) {
		const unit = units[index];
		salience = Math.max(salience, unit.salience);
		valenceSum += unit.valence * (.3 + unit.salience);
		arousalSum += unit.arousal * (.3 + unit.salience);
		domains.set(unit.domain, (domains.get(unit.domain) ?? 0) + 1);
		texts.push(unit.text);
	}
	let weight = 0;
	for (let index = fromIndex; index <= toIndex; index++) weight += .3 + units[index].salience;
	let domain = "other";
	let best = 0;
	for (const [candidate, count] of domains) if (candidate !== "other" && count > best) {
		best = count;
		domain = candidate;
	}
	return {
		fromIndex,
		toIndex,
		turnFrom: first.turn,
		turnTo: last.turn,
		l0From: first.id,
		l0To: last.lastId,
		startedAt: first.createdAt,
		endedAt: last.createdAt,
		salience,
		valence: weight === 0 ? 0 : valenceSum / weight,
		arousal: weight === 0 ? 0 : arousalSum / weight,
		domain,
		reason,
		secondary,
		text: texts.join("\n")
	};
}
/** Topic coherence of two adjacent segments: Jaccard of their text. */
function coherence(left, right) {
	return jaccard(left.text, right.text);
}
/** Emotional-arc continuity of two adjacent segments, in [0,1]. */
function arc(left, right) {
	return 1 - Math.min(1, Math.abs(left.salience - right.salience));
}
/** Merge two adjacent segments and recompute their aggregate fields. */
function mergePair(units, left, right) {
	const merged = makeSegment(units, left.fromIndex, right.toIndex, left.reason, left.secondary || right.secondary);
	merged.salience = Math.max(left.salience, right.salience);
	const weightLeft = left.toIndex - left.fromIndex + 1;
	const weightRight = right.toIndex - right.fromIndex + 1;
	merged.valence = (left.valence * weightLeft + right.valence * weightRight) / (weightLeft + weightRight);
	merged.arousal = (left.arousal * weightLeft + right.arousal * weightRight) / (weightLeft + weightRight);
	return merged;
}
/**
* Split a turn list into episodic segments.
* @param units - the turns to segment, oldest first, all from one identity.
* @param config - segmentation knobs.
* @param context - recent history used for the dynamic bound.
* @returns the segments plus the bound that produced them.
*/
function segmentTurns(units, config, context = {}) {
	if (units.length === 0) {
		const { bound: bound$1, sampleInsufficient: sampleInsufficient$1, reason: reason$1 } = dynamicBound(context, config);
		return {
			segments: [],
			bound: bound$1,
			sampleInsufficient: sampleInsufficient$1,
			boundReason: reason$1
		};
	}
	const { bound, sampleInsufficient, reason } = dynamicBound(context, config);
	const maxGapMs = config.gapMinutes * 6e4;
	const boundaries = [{
		index: 0,
		reason: "start"
	}];
	for (let index = 1; index < units.length; index++) {
		const previous = units[index - 1];
		const current = units[index];
		const gap = current.createdAt - previous.createdAt;
		const window = units.slice(Math.max(0, index - 3), index).map((unit) => unit.text).join("\n");
		const topical = jaccard(current.text, window);
		const domainShift = current.domain !== previous.domain && current.domain !== "other" && previous.domain !== "other";
		if (gap > maxGapMs) {
			boundaries.push({
				index,
				reason: "hard-gap"
			});
			continue;
		}
		if (domainShift && topical < config.hardTopicJaccard) {
			boundaries.push({
				index,
				reason: "hard-topic"
			});
			continue;
		}
		if (current.salience >= config.softSalience && current.salience - previous.salience >= config.softDelta) {
			boundaries.push({
				index,
				reason: "soft-emotion"
			});
			continue;
		}
		const lastBoundary = boundaries[boundaries.length - 1].index;
		if (index - lastBoundary >= bound * 2) boundaries.push({
			index,
			reason: "absolute"
		});
	}
	const firstLevel = [];
	for (let position = 0; position < boundaries.length; position++) {
		const start = boundaries[position];
		const end = boundaries[position + 1];
		const toIndex = end === void 0 ? units.length - 1 : end.index - 1;
		if (toIndex < start.index) continue;
		const blocks = [{
			from: start.index,
			to: toIndex,
			reason: start.reason
		}];
		let cursor = start.index;
		for (let index = start.index + 1; index <= toIndex; index++) {
			if (index - cursor < 2) continue;
			const current = units[index];
			const micro = units.slice(Math.max(cursor, index - 2), index).map((unit) => unit.text).join("\n");
			const drift = jaccard(current.text, micro) < config.microTopicJaccard;
			const spike = current.salience >= config.microSalience && current.salience - units[index - 1].salience >= .15;
			const forceSplit = index - cursor >= bound * 2;
			if (forceSplit || drift || spike) {
				const last = blocks[blocks.length - 1];
				last.to = index - 1;
				blocks.push({
					from: index,
					to: toIndex,
					reason: forceSplit ? "absolute" : drift ? "secondary-topic" : "secondary-emotion"
				});
				cursor = index;
			}
		}
		if (blocks.length === 1) {
			firstLevel.push(makeSegment(units, start.index, toIndex, start.reason, false));
			continue;
		}
		while (blocks.length > bound) {
			let bestIndex = 0;
			let bestScore = -1;
			for (let index = 0; index < blocks.length - 1; index++) {
				const left$1 = makeSegment(units, blocks[index].from, blocks[index].to, "start", true);
				const right$1 = makeSegment(units, blocks[index + 1].from, blocks[index + 1].to, "start", true);
				const score = coherence(left$1, right$1) * .6 + arc(left$1, right$1) * .4;
				if (score > bestScore) {
					bestScore = score;
					bestIndex = index;
				}
			}
			const left = blocks[bestIndex];
			const right = blocks[bestIndex + 1];
			blocks.splice(bestIndex, 2, {
				from: left.from,
				to: right.to,
				reason: left.reason
			});
		}
		for (let index = 0; index < blocks.length; index++) {
			const block = blocks[index];
			firstLevel.push(makeSegment(units, block.from, block.to, block.reason, index > 0 || block.reason.startsWith("secondary")));
		}
	}
	const merged = [];
	for (const segment of firstLevel) {
		const previous = merged[merged.length - 1];
		if (previous !== void 0 && previous.secondary && segment.secondary) {
			if (coherence(previous, segment) * .6 + arc(previous, segment) * .4 > .75) {
				merged[merged.length - 1] = mergePair(units, previous, segment);
				continue;
			}
		}
		merged.push(segment);
	}
	return {
		segments: merged,
		bound,
		sampleInsufficient,
		boundReason: reason
	};
}

//#endregion
//#region src/engine/consolidate.ts
/** Run `task` with a timeout and an optional external abort signal. */
async function withTimeout(task, ms, outer) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("timeout")), ms);
	const onAbort = () => controller.abort(outer?.reason);
	outer?.addEventListener("abort", onAbort, { once: true });
	try {
		return await task(controller.signal);
	} finally {
		clearTimeout(timer);
		outer?.removeEventListener("abort", onAbort);
	}
}
/** Extract the first JSON object from a model reply, tolerating fences and prose. */
function parseJsonReply(text) {
	const body = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)?.[1] ?? text;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) return void 0;
	try {
		const value = JSON.parse(body.slice(start, end + 1));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
	} catch {
		return;
	}
}
function asNumber(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function asString(value) {
	return typeof value === "string" ? value : "";
}
const KIND_SET = new Set([
	"fact",
	"preference",
	"instruction",
	"plan",
	"relationship"
]);
function parseKind(value, text) {
	if (typeof value === "string" && KIND_SET.has(value)) return value;
	if (looksInstructional(text)) return "instruction";
	if (looksPreference(text)) return "preference";
	if (/明天|下周|计划|打算|准备|要去|will |plan to|going to/iu.test(text)) return "plan";
	return "fact";
}
/** Group raw rows into turns, keeping only turns that carry user text. */
function toTurnUnits(rows) {
	const byTurn = /* @__PURE__ */ new Map();
	for (const row of rows) {
		if (row.text.trim().length === 0) continue;
		let bucket = byTurn.get(row.turn);
		if (bucket === void 0) {
			bucket = {
				id: row.id,
				lastId: row.id,
				turn: row.turn,
				user: [],
				assistant: [],
				createdAt: row.createdAt
			};
			byTurn.set(row.turn, bucket);
		}
		bucket.lastId = Math.max(bucket.lastId, row.id);
		bucket.id = Math.min(bucket.id, row.id);
		bucket.createdAt = Math.min(bucket.createdAt, row.createdAt);
		if (row.role === "user") bucket.user.push(row.text);
		else bucket.assistant.push(row.text);
	}
	const units = [];
	for (const bucket of [...byTurn.values()].sort((a, b) => a.turn - b.turn)) {
		if (bucket.user.length === 0) continue;
		const text = [`用户：${bucket.user.join("\n")}`, bucket.assistant.length > 0 ? `助手：${bucket.assistant.join("\n")}` : ""].filter(Boolean).join("\n");
		const reading = readEmotion(bucket.user.join("\n"));
		const domain = detectDomain(text).domain;
		units.push({
			id: bucket.id,
			lastId: bucket.lastId,
			turn: bucket.turn,
			text,
			createdAt: bucket.createdAt,
			salience: reading.salience,
			valence: reading.valence,
			arousal: reading.arousal,
			domain
		});
	}
	return units;
}
const EXTRACT_SYSTEM = "你是一个严谨的记忆整理器。你只输出 JSON，不输出任何解释。";
function extractPrompt(text, locale, names, aliasCount = 0) {
	const language = locale === "zh" ? "中文" : "English";
	/*
	* Retrieval aliases. The strict pass ANDs every bigram of the user's
	* sentence, so a fact written as 「用户辞职后一直没跟家里说」 is unreachable
	* by 「我没告诉爸妈」 no matter how relevant it is: the words simply are not
	* in the row. Asking the model for the words the user *would* use, at the
	* moment it already has the conversation in front of it, puts them there —
	* and keeps the query side (and its latency) untouched.
	*
	* The rules below ask for 问法, not 同义说法, and the difference is measured
	* rather than theoretical: over 11 aliases in a real store, zero contained an
	* interrogative. The model had been writing another *name* for the thing
	* (「健康检查」 for 「体检」), which is exactly what a user does not type —
	* he types 「身体怎么样」. A synonym only helps if the user reaches for the
	* formal word, and the user who reaches for the formal word never needed the
	* alias in the first place.
	*/
	const aliasRules = aliasCount <= 0 ? [] : [
		`- 每条事实再给 aliases：2–3 个「${names.user}下次会用什么话问起这件事」。要写成他真会打出来的问法，不是这件事的另一个名字：「下周三体检」的别名是「身体怎么样」「什么时候去查」；写「健康检查」等于没写，因为他不会那样问。口语、带具体对象名，每个 ≤6 字。`,
		"- aliases 不要写「工作」「心情」「事情」这类泛词，也不要只写「怎么样」「什么时候」这种离开对象就没有意义的问句壳，也不要照抄原句或标题——它们的唯一作用是让一条写死在某处的记忆，能被另一种说法找到。",
		"- 事实里提到人（家人、同事、朋友、客户）时，把用户对这个人的其他叫法都写进 aliases：「我妈」「母亲」「李慧」是同一个人，缺了哪一个，用那个说法就再也找不回来。",
		"- 同时给这一段一个 aliases：2–3 个关于这件事的问法（「那个项目怎么样」「方案交了没」），用于以后认出同一个话题。"
	];
	const aliasFields = aliasCount <= 0 ? {
		top: "",
		fact: ""
	} : {
		top: "\"aliases\":[],",
		fact: ",\"aliases\":[]"
	};
	return [
		`阅读下面这段对话（说话者是「${names.user}」），抽取值得长期记住的原子事实。用${language}输出。`,
		"",
		"规则：",
		"- 每条事实必须自包含：脱离上下文也能读懂，一句话，主语用「用户」或「我（助手）」。",
		"- 抽两类，都要：① 关于他这个人——偏好、身份背景、关系、明确的长期要求；② 这段对话里他自己说的具体事——做了什么、遇到什么、卡在哪、做到哪一步、和谁、结论是什么。",
		"- ②不是流水账，是「上次那件事」的落点。只抽①的代价很具体：他问「上次那个迁移怎么样了」，答案不在①里，而他想不起来把经过再讲一遍。",
		"- ②的反例：「用户在讨论代码」「助手建议先备份」是概括，没有对象也没有结论，不要写；要写「用户把同步任务的报错定位到 WAL 锁冲突」这种一句就能独立读懂的话。",
		"- 不要抽取：寒暄、纯工具输出、助手自己的推理、任何密钥或密码；也不要为了凑数把一句话拆成三条。",
		"- 用户明确要求的行为规则（如“以后都…”）kind 标为 instruction。",
		"- 用户说要做、但还没发生的事（打算 / 准备 / 下周要去 / 约好）kind 标为 plan。它和事实分开，是因为计划会到期而事实不会：留 null 就等于把它放进一个永远不提醒的抽屉。",
		"- 句子里有时间短语就把它原样抄进 ttl（「下周三」「过几天」「11月9日」「两周后」都算），一个字都不要改，也不要自己换算成日期——换算由代码做，你换算会错。只是泛泛而谈（过段时间、以后、改天）就写 null。计划尤其如此，但不要替用户编一个期限。",
		"- 最多 8 条。宁可少抽，不要编造——「少抽」是不把一个意思拆成三条，不是只抽①不抽②。整段只有寒暄、只有让助手干活时，facts 给空数组：交白卷比编一条强。",
		"- 每条事实再给 quote：从上面这段对话里逐字复制的一小段（≤30 字），就是支撑这条事实的那几个字。不要改写主语——原文说「我」就写「我」，别换成「用户」；不要补全省略的部分；不要改标点。不连续的两段用「……」隔开。找不到能支撑的原句，就把这条事实删掉：写不出 quote 的事实，多半是你自己补出来的。",
		...aliasRules,
		"- 同时给出：标题（≤16 字）、摘要（≤120 字）、整体情绪（valence -1..1，arousal 0..1，salience 0..1）。",
		"- 标题要能当这一段的索引：写清在做什么、涉及哪个具体对象（项目名 / 工具名 / 作品名 / 人名 / 地点）。"
			+ "不要只写「工作」「技术」这类领域词，也不要照抄第一句话——以后要靠标题把同一件事的几段认出来。",
		"- 如果这段对话让你对用户形成了新印象，写一句 impression（≤60 字），否则 null。",
		"- 如果你作为助手想写一句日记（只写自己的感受与想法，不复述隐私细节），写 diary（≤80 字），否则 null。",
		"",
		"输出 JSON：",
		`{"title":"","summary":"",${aliasFields.top}"emotion":{"valence":0,"arousal":0,"salience":0},"impression":null,"diary":null,"facts":[{"text":"","kind":"fact","ttl":null,"confidence":0.8,"quote":""${aliasFields.fact}}]}`,
		"",
		"对话：",
		clip(text, 6e3)
	].join("\n");
}
const JUDGE_SYSTEM = "你是一个记忆冲突判定器。你只输出 JSON，不输出任何解释。";
function judgePrompt(candidates, neighbors) {
	const lines = [];
	candidates.forEach((candidate, index) => {
		lines.push(`候选 ${index}: ${candidate.text}`);
		const related = neighbors.get(index) ?? [];
		if (related.length === 0) lines.push("  相邻记忆：无");
		for (const fact of related) lines.push(`  #${fact.id} [${fact.kind}] ${fact.text}`);
	});
	return [
		"判断每个候选事实与「相邻记忆」的关系，并给候选打情绪显著度。",
		"- duplicate：与某条相邻记忆说的是同一件事（信息量基本相同）。",
		"- update：同一件事，但候选更准确或更新，应当更新那条记忆。",
		"- contradicts：候选与某条相邻记忆互相否定或数值冲突。",
		"- unrelated：没有关系。",
		"- salience：这条事实的情绪显著度 0..1（平淡的 0.1，强烈情绪/亲密披露的 0.8+）。",
		"- ttl：候选文本里若有期限且抽取时遗漏，补上原文短语，否则 null。",
		"",
		"输入：",
		...lines,
		"",
		"输出 JSON：",
		"{\"results\":[{\"index\":0,\"relation\":\"unrelated\",\"target\":null,\"salience\":0.2,\"ttl\":null}]}"
	].join("\n");
}
/**
* Strip what a spoken sentence opens with: discourse markers, and the leftover
* 「用户：」 prefix that survives the segment join.
* @param text - one sentence.
* @returns the sentence without its opener.
*/
function stripOpener(text) {
	return text.replace(/^(?:那么|但是|不过|所以|然后|对了|其实|也就是说|嗯|啊|诶|哎|哦)+[，,、。\s]*/u, "").replace(/^用户：/u, "").trim();
}
/**
* Pick the sentence that best serves as an index entry for one episode.
*
* The old fallback produced `${domain}·${first sentence}`, which in practice
* gave a library of blocks all called 「技术·那我们把这段改一下」: the domain
* prefix carries no information (it already has its own column). Keep the first
* substantial sentence rather than the longest one — the first sentence is the
* one that names the subject, and picking by length drops the subject whenever
* the user opens with a short statement and then explains.
* @param parts - the user sentences of one segment, in order.
* @param fallback - used when there is no usable sentence at all.
* @returns a title capped at 32 characters.
*/
function episodeTitle(parts, fallback) {
	const clean = parts.map((part) => stripOpener(String(part))).filter((part) => part.length >= 6);
	const chosen = clean.length > 0 ? clean[0] : stripOpener(String(fallback));
	return clip(chosen.length > 0 ? chosen : String(fallback).trim(), 32);
}
/**
* Summary fallback: the opening sentence plus the longest one, so a block keeps
* both where it started and what it was actually about.
*
* Tried and reverted: picking that second sentence by 「carries a concrete value」
* (a number, an identifier) instead of by length. The motivation was real — on
* technical records the sentence holding the number is usually the one someone
* asks about months later, and that variant put the key sentence into the
* summary 82.6% of the time against 26.6% here. Retrieval scores on the same
* questions went the other way, 20.3% down to 8.7%, and narrative text was
* worse still: in a story the numbered sentences are 「三天后」 and 「第十年」,
* while the plot point is the longest one. A rule that only holds on one kind
* of writing is not a rule, so this stays length-based until there is a signal
* that works on both.
* @param parts - the user sentences of one segment, in order.
* @param fallback - the raw segment text, used when there is no usable sentence.
* @returns a summary capped at 200 characters.
*/
function episodeSummary(parts, fallback) {
	const clean = parts.map((part) => stripOpener(String(part))).filter((part) => part.length >= 4);
	if (clean.length === 0) return clip(String(fallback).trim(), 200);
	const first = clean[0];
	let longest = clean[0];
	for (const part of clean) if (part.length > longest.length) longest = part;
	if (longest === first) return clip(first, 200);
	return clip(`${first} ${longest}`, 200);
}
/** Rule-only extraction, used without a model or after a model failure. */
function extractWithRules(text, domain, locale, now = Date.now(), timeZone = "UTC") {
	const reading = readEmotion(text);
	const assistantAt = text.indexOf("\n助手：");
	const userPart = (assistantAt >= 0 ? text.slice(0, assistantAt) : text).replace(/^用户：/u, "");
	const candidates = [];
	const seen = [];
	for (const sentence of sentences(userPart)) {
		const clean = sentence.trim();
		if (clean.length < 6 || clean.length > 220) continue;
		if (containsSecret(clean)) continue;
		if (!looksWorthKeeping(clean)) continue;
		if (seen.some((existing) => jaccard(existing, clean) > .6)) continue;
		seen.push(clean);
		const kind = parseKind(void 0, clean);
		candidates.push({
			text: clip(clean, 200),
			kind,
			ttl: hasTemporal(clean, now, timeZone) ? clean : null,
			confidence: .55
		});
		if (candidates.length >= 6) break;
	}
	const parts = sentences(userPart);
	const firstUser = parts[0] ?? userPart;
	/*
	* `domain` stays in the signature because the caller still passes it, but it
	* no longer goes into the title: a prefix like 「技术·」 is the same on every
	* block from one day and tells a reader nothing about which project the block
	* belongs to.
	*/
	return {
		title: episodeTitle(parts, firstUser),
		summary: episodeSummary(parts, userPart),
		aliases: [],
		facts: candidates,
		emotion: reading,
		impression: null,
		diary: null,
		fromModel: false
	};
}
/**
* Whether a sentence carries a deadline, asked of the resolver that will parse
* it rather than of a second hand-written list. The two lists drifted apart
* once already: `parseDue` learned 下个月五号 and the fallback never knew.
*
* `recurring` sentences are excluded — the fallback has no model to tell a
* habit from a deadline, and 「每周一」 must not become one date.
* @param text - a candidate sentence.
* @param now - when the segment was said.
* @param timeZone - the conversation's zone.
*/
function hasTemporal(text, now, timeZone) {
	if (/每(?:天|日|个?(?:周|星期|礼拜|月|年))/u.test(text)) return false;
	return parseDue(text, now, timeZone) !== void 0;
}
/** Ask the model to extract one episode, with a hard timeout. */
async function extractWithModel(deps, text, identity, segment) {
	if (deps.llm === void 0) return void 0;
	if (!deps.canUseLlm(identity.id)) return void 0;
	const aliasLimit = deps.config.consolidation.aliasCount;
	const prompt = extractPrompt(text, deps.config.locale, { user: identity.name }, aliasLimit);
	try {
		const reply = await withTimeout((signal) => deps.llm({
			system: EXTRACT_SYSTEM,
			prompt,
			provider: deps.route?.provider,
			model: deps.route?.model,
			/*
			* 1200, not 900: every fact now carries a `quote`, so the same 8 facts
			* need roughly a third more output tokens than before. A reply cut off
			* mid-JSON fails to parse, and a failed parse drops the whole segment
			* to the rule path — the failure mode is silent memory loss, not a
			* visible error. This is a ceiling, not a spend.
			*/
			maxTokens: 1200,
			signal
		}), deps.config.consolidation.itemTimeoutSeconds * 1e3, deps.signal);
		deps.recordUsage(identity.id, 1, Math.ceil(prompt.length / 3), Math.ceil(reply.text.length / 3));
		const json = parseJsonReply(reply.text);
		if (json === void 0) return void 0;
		const factsRaw = Array.isArray(json["facts"]) ? json["facts"] : [];
		const facts = [];
		for (const raw of factsRaw) {
			if (typeof raw !== "object" || raw === null) continue;
			const record = raw;
			const factText = asString(record["text"]).trim();
			if (factText.length < 4 || factText.length > 240) continue;
			if (containsSecret(factText)) continue;
			facts.push({
				text: factText,
				kind: parseKind(record["kind"], factText),
				ttl: typeof record["ttl"] === "string" && record["ttl"].trim().length > 0 ? record["ttl"] : null,
				confidence: Math.max(0, Math.min(1, asNumber(record["confidence"], .75))),
				/*
				* The excerpt, kept as the model wrote it. Checked later against
				* the segment (`applyCandidate`), never fixed up here: rewriting
				* it would hide exactly the thing the check exists to see.
				*/
				quote: typeof record["quote"] === "string" && record["quote"].trim().length > 0 ? clip(record["quote"].trim(), 80) : null,
				aliases: cleanAliases(record["aliases"], aliasLimit)
			});
			if (facts.length >= 10) break;
		}
		const emotionRaw = typeof json["emotion"] === "object" && json["emotion"] !== null ? json["emotion"] : {};
		const modelEmotion = {
			salience: asNumber(emotionRaw["salience"], segment.salience),
			valence: asNumber(emotionRaw["valence"], segment.valence),
			arousal: asNumber(emotionRaw["arousal"], segment.arousal)
		};
		/*
		* A model that answers with an empty title used to get the bare domain
		* name, so every block from one afternoon shared a title and could not be
		* told apart. Fall back to the same sentence-based title the rule path
		* uses instead.
		*/
		const givenTitle = asString(json["title"]).trim();
		const givenSummary = asString(json["summary"]).trim();
		const fallbackParts = sentences(text);
		return {
			title: givenTitle.length > 0 ? clip(givenTitle, 32) : episodeTitle(fallbackParts, text),
			summary: givenSummary.length > 0 ? clip(givenSummary, 200) : episodeSummary(fallbackParts, segment.text),
			aliases: cleanAliases(json["aliases"], Math.min(aliasLimit, 3)),
			facts,
			emotion: blendEmotion({
				salience: segment.salience,
				valence: segment.valence,
				arousal: segment.arousal,
				cues: []
			}, modelEmotion),
			impression: typeof json["impression"] === "string" && json["impression"].trim().length > 0 ? clip(json["impression"].trim(), 120) : null,
			diary: typeof json["diary"] === "string" && json["diary"].trim().length > 0 ? clip(json["diary"].trim(), 160) : null,
			fromModel: true
		};
	} catch {
		return;
	}
}
/** Find up to five nearest existing facts for each candidate (Q24/Q25: Top-5, loose). */
function findNeighbours(store, identityId, candidates) {
	const map = /* @__PURE__ */ new Map();
	candidates.forEach((candidate, index) => {
		const match = compileMatch(candidate.text);
		if (match === void 0) {
			map.set(index, []);
			return;
		}
		const hits = store.searchFacts(identityId, match, 5).filter((hit) => jaccard(hit.text, candidate.text) >= .12);
		map.set(index, hits);
	});
	return map;
}
/** Rule judgement against neighbours. */
function judgeWithRules(candidate, neighbours, segmentSalience) {
	let best;
	let bestScore = 0;
	for (const fact of neighbours) {
		const score = jaccard(candidate.text, fact.text);
		if (score > bestScore) {
			bestScore = score;
			best = fact;
		}
	}
	const own = readEmotion(candidate.text).salience;
	const salience = Math.max(own, segmentSalience * .6);
	if (best === void 0 || bestScore < .45) return {
		relation: "unrelated",
		target: null,
		salience,
		ttl: candidate.ttl
	};
	const negationFlip = /(?:不|没|别|never|not)/iu.test(candidate.text) !== /(?:不|没|别|never|not)/iu.test(best.text);
	const numbersDiffer = numbersOf$1(candidate.text).join(",") !== numbersOf$1(best.text).join(",");
	if (negationFlip || numbersDiffer && bestScore >= .5) return {
		relation: "contradicts",
		target: best.id,
		salience,
		ttl: candidate.ttl
	};
	if (bestScore >= .8) return {
		relation: "duplicate",
		target: best.id,
		salience,
		ttl: candidate.ttl
	};
	return {
		relation: "update",
		target: best.id,
		salience,
		ttl: candidate.ttl
	};
}
function numbersOf$1(text) {
	return text.match(/\d+/gu) ?? [];
}
/** Ask the model for the four judgements in one call (Q54). */
async function judgeWithModel(deps, identity, candidates, neighbours, segmentSalience) {
	if (deps.llm === void 0 || !deps.canUseLlm(identity.id) || candidates.length === 0) return void 0;
	const prompt = judgePrompt(candidates, neighbours);
	try {
		const reply = await withTimeout((signal) => deps.llm({
			system: JUDGE_SYSTEM,
			prompt,
			provider: deps.route?.provider,
			model: deps.route?.model,
			maxTokens: 600,
			signal
		}), deps.config.consolidation.itemTimeoutSeconds * 1e3, deps.signal);
		deps.recordUsage(identity.id, 1, Math.ceil(prompt.length / 3), Math.ceil(reply.text.length / 3));
		const json = parseJsonReply(reply.text);
		if (json === void 0 || !Array.isArray(json["results"])) return void 0;
		const results = /* @__PURE__ */ new Map();
		for (const raw of json["results"]) {
			if (typeof raw !== "object" || raw === null) continue;
			const record = raw;
			const index = asNumber(record["index"], -1);
			if (index >= 0) results.set(index, record);
		}
		return candidates.map((candidate, index) => {
			const record = results.get(index);
			if (record === void 0) return judgeWithRules(candidate, neighbours.get(index) ?? [], segmentSalience);
			const relation = asString(record["relation"]);
			const target = typeof record["target"] === "number" ? record["target"] : null;
			const valid = relation === "duplicate" || relation === "update" || relation === "contradicts" || relation === "unrelated";
			return {
				relation: valid ? relation : "unrelated",
				target: valid ? target : null,
				salience: Math.max(0, Math.min(1, asNumber(record["salience"], segmentSalience))),
				ttl: typeof record["ttl"] === "string" && record["ttl"].trim().length > 0 ? record["ttl"] : candidate.ttl
			};
		});
	} catch {
		return;
	}
}
/** The user explicitly corrected the assistant; the old fact becomes disputed (Q34). */
function correctionMarker(text) {
	return /(?:不对|不是这样|记错了|我说的是|纠正|更正|我改主意|actually|that's wrong|i said)/iu.test(text);
}
/**
* How a newly stated deadline meets the one already stored.
*
* Four outcomes, and only one of them is safe to apply silently:
*
* - `fill`   — nothing was stored; there is nothing to contradict
* - `same`   — the same window, said twice
* - `refine` — the new window sits inside the old one ("下周" → "下周一")
* - `shift`  — the new window moved somewhere else entirely
*
* `refine` and `shift` both overwrite a date the user already gave us. Both get
* staged and asked, because a silently overwritten deadline is the worst kind
* of wrong: it renders later with full confidence on the wrong day, and nothing
* in the block hints that the day was ever in doubt. A refinement is not
* automatically safe just because it fits inside the old window — the old
* window may be the one the user actually meant.
*
* @param target - the stored fact.
* @param next - the newly resolved window, if the sentence carried one.
* @param timeZone - the conversation's zone, for reading a legacy row's start.
* @returns which of the four cases this is.
*/
function reconcileDue(target, next, timeZone) {
	if (next === void 0 || target.expiresAt === null) return next === void 0 ? "same" : "fill";
	// Rows written before due windows existed only have an end; treat the day
	// it ends on as the interval, so an old fact can still be refined.
	const oldFrom = target.dueFrom ?? startOfLocalDay(target.expiresAt, timeZone);
	if (oldFrom === next.from && target.expiresAt === next.to) return "same";
	if (next.from >= oldFrom && next.to <= target.expiresAt) return "refine";
	return "shift";
}
/** Apply one judged candidate to the store. */
function applyCandidate(input) {
	const { store, config, identity, candidate, judgement, segment, timezone, now } = input;
	const salience = Math.max(0, Math.min(1, judgement.salience));
	const ttlPhrase = judgement.ttl ?? candidate.ttl;
	/*
	* A deadline belongs to a promise, not to a memory. 「今天我把车卖了」 is a
	* finished fact; hanging today's window on it would have the block print
	* 「已到期」 from tomorrow on, and maintenance would decay the fact for
	* having kept its word. Only plans carry a window — everything else keeps
	* the phrase in `evidence` and nothing else.
	*/
	const due = ttlPhrase === null || candidate.kind !== "plan" ? void 0 : parseDue(ttlPhrase, segment.startedAt, timezone);
	if (candidate.kind === "instruction" || looksInstructional(candidate.text)) {
		store.insertPreference(identity.id, candidate.text, segment.l0From, now);
		store.audit(identity.id, "preference.write", "preference", null, { text: candidate.text }, now);
		return {
			action: "created",
			id: -1
		};
	}
	const target = judgement.target === null ? void 0 : store.getFact(judgement.target);
	if (judgement.relation === "duplicate" && target !== void 0) {
		const stability = boostedStability(target.stability, config.decay.retrievalBoost, target.stabilityMax);
		const how = reconcileDue(target, due, timezone);
		const evidence = {
			...target.evidence,
			lastSeen: now,
			sources: [...new Set([...target.sourceIds ?? [], segment.l0From])]
		};
		if (how === "refine" || how === "shift") evidence.pendingDue = {
			from: due.from,
			to: due.to,
			kind: due.kind,
			precision: due.precision,
			phrase: due.phrase,
			relation: how,
			proposedAt: now
		};
		store.updateFactState(target.id, {
			confidence: Math.max(target.confidence, candidate.confidence),
			evidence,
			updatedAt: now
		});
		if (how === "fill") store.updateFactDue(target.id, due, now);
		store.markAccessed(target.id, now, stability, target.accessCount + 1);
		if ((candidate.aliases ?? []).length > 0) store.addFactAliases(target.id, candidate.aliases, now, config.consolidation.aliasCount);
		return {
			action: "merged",
			id: target.id
		};
	}
	if (judgement.relation === "update" && target !== void 0) {
		const stability = boostedStability(target.stability, config.decay.retrievalBoost * 1.5, target.stabilityMax);
		store.updateFactText(target.id, candidate.text, [segment.domain, candidate.kind], Math.max(target.salience, salience), Math.max(target.base, baseFromSalience(salience)), now);
		if ((candidate.aliases ?? []).length > 0) store.addFactAliases(target.id, candidate.aliases, now, config.consolidation.aliasCount);
		const how = reconcileDue(target, due, timezone);
		const evidence = how === "refine" || how === "shift" ? {
			...target.evidence,
			pendingDue: {
				from: due.from,
				to: due.to,
				kind: due.kind,
				precision: due.precision,
				phrase: due.phrase,
				relation: how,
				proposedAt: now
			}
		} : target.evidence;
		store.updateFactState(target.id, {
			confidence: Math.max(target.confidence, candidate.confidence),
			evidence,
			updatedAt: now
		});
		if (how === "fill") store.updateFactDue(target.id, due, now);
		store.markAccessed(target.id, now, stability, target.accessCount + 1);
		return {
			action: "merged",
			id: target.id
		};
	}
	/*
	* The checksum. `quote` is the excerpt the extractor says it copied out of
	* this segment; one local substring test says whether it really did. A fact
	* that was composed rather than read shows up here at zero cost — no second
	* model call, no extra storage.
	*
	* Recorded, never enforced. The extract prompt rewrites the subject to
	* 「用户」, and a model that carries that rewrite into its quote would fail
	* a test it does not deserve to fail. Counting first and blocking later is
	* the only order that can tell a real fabrication from that one.
	*/
	/*
	* Clip first, then judge. The verdict and the excerpt it is about have to
	* be the same string, or the store ends up holding a 60-char quote whose
	* `true` was earned by the 20 characters that got cut off.
	*/
	const excerpt = typeof candidate.quote === "string" ? clip(candidate.quote, 60) : candidate.quote;
	const quoteCheck = quoteMatches(excerpt, segment.text);
	const provenance = {
		ttlPhrase: ttlPhrase ?? null,
		duePrecision: due?.precision ?? null
	};
	if (quoteCheck !== null) {
		provenance.quote = excerpt;
		provenance.quoteVerified = quoteCheck;
	}
	const created = store.insertFact({
		identityId: identity.id,
		text: candidate.text,
		kind: candidate.kind,
		source: "dialogue",
		domain: segment.domain,
		tags: [segment.domain, candidate.kind],
		salience,
		base: baseFromSalience(salience),
		stability: config.decay.sInitial,
		stabilityMax: config.decay.sInitial * config.decay.sMaxMultiplier,
		confidence: candidate.confidence,
		ttl: due === void 0 ? "none" : due.kind,
		expiresAt: due?.to ?? null,
		dueFrom: due?.from ?? null,
		fromVisitor: identity.role === "visitor",
		isolated: false,
		sourceIds: [segment.l0From, segment.l0To],
		evidence: provenance,
		aliases: candidate.aliases ?? [],
		aliasLimit: config.consolidation.aliasCount,
		createdAt: now,
		updatedAt: now
	});
	if (judgement.relation === "contradicts" && target !== void 0) {
		store.addEdge(created, target.id, "SUPERSEDES", now);
		if (input.correction) {
			store.updateFactState(target.id, {
				status: "disputed",
				weight: .3,
				updatedAt: now
			});
			store.addEdge(created, target.id, "CONTRADICTS", now);
		} else store.updateFactState(target.id, {
			status: "superseded",
			supersededBy: created,
			weight: .5,
			updatedAt: now
		});
		return {
			action: "superseded",
			id: created
		};
	}
	return {
		action: "created",
		id: created
	};
}
/** Build a rule-based impression when the model did not supply one and none exists. */
function seedImpression(store, identity, now) {
	if (store.getImpression(identity.id) !== void 0) return;
	const facts = store.factsForIdentity(identity.id, 20).filter((fact) => fact.kind === "preference" || fact.kind === "relationship");
	if (facts.length === 0) return;
	const text = clip(facts.slice(0, 3).map((fact) => fact.text).join("；"), 120);
	store.upsertImpression(identity.id, text, .35, 1, now);
}
/** Count of consolidated episodes used as narrative evidence. */
function narrativeEvidence(store) {
	const row = store.db.prepare("SELECT COUNT(*) AS n FROM events").get();
	return typeof row.n === "number" ? row.n : 0;
}
/**
* Display names for the reasons a consolidation fell back to the rule path.
* Kept next to the counter that produces them so a new reason cannot be added
* on one side and print as a raw identifier on the other.
*/
const DEGRADE_LABEL = {
	budget: "模型配额用尽",
	model: "模型调用失败",
	judge: "判断层降级"
};
/**
* Severity order for the reasons above, so one segment counts once.
*
* A segment can degrade twice in the same pass: extraction falls back, and
* then the judgement call falls back on the facts that the rule path did
* produce. Counting each event reported 2 segments' worth of degradation for
* 1 segment, and the doctor line says 「段」 — a reader has no way to notice the
* number is a tally of events rather than of memories. Keep the worst reason:
* 「配额用尽」 is the one that changes what the user should do, and the others
* are consequences of it or of a single bad call.
*/
const DEGRADE_RANK = {
	judge: 1,
	model: 2,
	budget: 3
};
/**
* Pick the more severe of two reasons for the same segment.
* @param current - the reason already recorded, or null.
* @param next - the reason just observed.
* @returns whichever ranks higher.
*/
function worseReason(current, next) {
	if (current === null) return next;
	return (DEGRADE_RANK[next] ?? 0) > (DEGRADE_RANK[current] ?? 0) ? next : current;
}
/**
* Whether one identity has spent today's model allowance.
*
* Deliberately reads the same counter that enforcement reads (`dailyCalls`
* against `dailyLlmCalls`) instead of carrying its own tally: two counters
* would let the plugin decide it is out of budget while the guard still lets
* calls through, which is how a "degraded" flag ends up disagreeing with
* reality. The try/catch is not defensiveness theatre — this runs on the
* diagnostic path, and a read failure there must not abort a consolidation
* that would otherwise succeed on the rule path.
* @param deps - store, config, clock.
* @param identityId - whose allowance.
* @returns true when the model must not be called today.
*/
function dailyBudgetSpent(deps, identityId) {
	const limit = deps.config.consolidation.dailyLlmCalls;
	if (!Number.isFinite(limit) || limit <= 0) return true;
	try {
		return deps.store.dailyCalls(identityId, dayKey(deps.now, deps.timezone)) >= limit;
	} catch {
		return false;
	}
}
/**
* Consolidate one session's pending raw turns.
* @param deps - store, config, clock, optional model bridge.
* @param sessionId - the session to fold.
* @param identity - the partner the session speaks for.
* @returns a report of what changed.
*/
async function consolidateSession(deps, sessionId, identity) {
	const startedWall = Date.now();
	const report = {
		sessionId,
		identityId: identity.id,
		l0Processed: 0,
		segments: 0,
		factsCreated: 0,
		factsMerged: 0,
		factsSuperseded: 0,
		eventsCreated: 0,
		usedModel: false,
		degraded: false,
		/*
		* `degraded` alone is one bit for three unrelated situations, and they
		* need different answers: running out of today's model budget is an
		* account problem that clears at midnight, a model call that timed out
		* or returned unparseable JSON is a provider problem, and a missing
		* model is just the rule-only setup. Collapsing them into one boolean
		* meant the only observable trace of a spent budget was that facts got
		* worse — the failure looked like the plugin forgetting, not like the
		* budget ending.
		*/
		degradeReasons: {},
		errors: [],
		durationMs: 0
	};
	const rows = deps.store.pendingL0(sessionId);
	if (rows.length === 0) return report;
	const units = toTurnUnits(rows);
	if (units.length === 0) {
		deps.store.markL0Consolidated(rows.map((row) => row.id));
		return report;
	}
	const recentLengths = deps.store.recentEventLengths(identity.id, deps.config.consolidation.sampleK);
	const totalTurns = recentLengths.reduce((sum, length) => sum + length, 0) + units.length;
	const segmentation = segmentTurns(units, {
		gapMinutes: deps.config.segmentation.gapMinutes,
		hardTopicJaccard: deps.config.segmentation.hardTopicJaccard,
		softSalience: deps.config.segmentation.softSalience,
		softDelta: deps.config.segmentation.softDelta,
		microTopicJaccard: deps.config.segmentation.microTopicJaccard,
		microSalience: deps.config.segmentation.microSalience,
		minSecondary: deps.config.segmentation.minSecondary
	}, {
		recentSegmentTurns: recentLengths,
		totalTurnsSoFar: totalTurns,
		sampleK: deps.config.consolidation.sampleK,
		sampleM: deps.config.consolidation.sampleM
	});
	report.segments = segmentation.segments.length;
	const deadline = startedWall + deps.config.consolidation.maxRunSeconds * 1e3;
	for (const segment of segmentation.segments) {
		if (Date.now() > deadline) {
			report.errors.push("达到单次整合时长上限，剩余片段留待下次");
			break;
		}
		let segmentReason = null;
		try {
			const extraction = await extractWithModel(deps, segment.text, identity, segment) ?? extractWithRules(segment.text, segment.domain, deps.config.locale, segment.startedAt, deps.timezone);
			report.usedModel ||= extraction.fromModel;
			if (!extraction.fromModel && deps.llm !== void 0) {
				report.degraded = true;
				/*
				* The budget check has to happen out here, not inside
				* `extractWithModel`: that function only receives a boolean and
				* cannot tell 「today's allowance ran out」 from 「this call
				* failed」. The two mean opposite things to the user — one heals
				* by itself at midnight, the other needs a different model.
				*/
				const reason = dailyBudgetSpent(deps, identity.id) ? "budget" : "model";
				segmentReason = worseReason(segmentReason, reason);
			}
			const neighbours = findNeighbours(deps.store, identity.id, extraction.facts);
			const modelJudgements = await judgeWithModel(deps, identity, extraction.facts, neighbours, extraction.emotion.salience);
			if (modelJudgements === void 0 && extraction.facts.length > 0 && deps.llm !== void 0) {
				report.degraded = true;
				const reason = dailyBudgetSpent(deps, identity.id) ? "budget" : "judge";
				segmentReason = worseReason(segmentReason, reason);
			}
			const judgements = extraction.facts.map((candidate, index) => modelJudgements?.[index] ?? judgeWithRules(candidate, neighbours.get(index) ?? [], extraction.emotion.salience));
			const correction = correctionMarker(segment.text);
			const factIds = [];
			extraction.facts.forEach((candidate, index) => {
				const judgement = judgements[index];
				const applied = applyCandidate({
					store: deps.store,
					config: deps.config,
					identity,
					candidate,
					judgement,
					segment,
					timezone: deps.timezone,
					now: deps.now,
					correction
				});
				if (applied.id > 0) factIds.push(applied.id);
				if (applied.action === "created") report.factsCreated++;
				else if (applied.action === "merged") report.factsMerged++;
				else report.factsSuperseded++;
			});
			const eventId = deps.store.insertEvent({
				identityId: identity.id,
				sessionId,
				title: extraction.title,
				summary: extraction.summary,
				aliases: extraction.aliases ?? [],
				aliasLimit: deps.config.consolidation.aliasCount,
				domain: segment.domain,
				startedAt: segment.startedAt,
				endedAt: segment.endedAt,
				turnFrom: segment.turnFrom,
				turnTo: segment.turnTo,
				salience: extraction.emotion.salience,
				valence: extraction.emotion.valence,
				arousal: extraction.emotion.arousal,
				l0From: segment.l0From,
				l0To: segment.l0To,
				createdAt: deps.now
			}, factIds);
			deps.store.assignL0Event(units.filter((unit) => unit.turn >= segment.turnFrom && unit.turn <= segment.turnTo).map((unit) => unit.id), eventId);
			report.eventsCreated++;
			if (extraction.impression !== null) {
				const previous = deps.store.getImpression(identity.id);
				const observations = (previous?.observations ?? 0) + 1;
				const confidence = Math.min(.95, (previous?.confidence ?? .4) * .7 + .3 * .6 + .05);
				deps.store.upsertImpression(identity.id, extraction.impression, confidence, observations, deps.now);
			} else seedImpression(deps.store, identity, deps.now);
			if (extraction.diary !== null) {
				const key = dayKey(deps.now, deps.timezone);
				if (deps.store.countDiaryOn(identity.id, key) < deps.config.consolidation.diaryPerDay) deps.store.addDiary(identity.id, extraction.diary, key, deps.now);
			}
			const evidence = narrativeEvidence(deps.store);
			const current = deps.store.currentNarrative();
			if (extraction.fromModel && evidence >= deps.config.consolidation.narrativeEvidence && (current === void 0 || evidence - current.evidenceCount >= deps.config.consolidation.narrativeEvidence)) {
				const revised = await reviseNarrative(deps, identity, current?.text ?? "");
				if (revised !== null) deps.store.insertNarrative(revised, evidence, deps.now);
			}
		} catch (error) {
			report.errors.push(error instanceof Error ? error.message : String(error));
			report.degraded = true;
			deps.store.deadLetter("consolidate-retry", {
				sessionId,
				identityId: identity.id,
				l0From: segment.l0From,
				l0To: segment.l0To,
				error: error instanceof Error ? error.message : String(error)
			}, error instanceof Error ? error.message : String(error), deps.now, `retry:${sessionId}:${segment.l0From}`);
			deps.store.trace({
				at: deps.now,
				sessionId,
				operation: "consolidate",
				channel: null,
				detail: {
					l0From: segment.l0From,
					l0To: segment.l0To
				},
				durationMs: null,
				error: error instanceof Error ? error.message : String(error)
			});
			try {
				deps.store.insertEvent({
					identityId: identity.id,
					sessionId,
					title: episodeTitle(sentences(segment.text), segment.text),
					summary: episodeSummary(sentences(segment.text), segment.text),
					domain: segment.domain,
					startedAt: segment.startedAt,
					endedAt: segment.endedAt,
					turnFrom: segment.turnFrom,
					turnTo: segment.turnTo,
					salience: segment.salience,
					valence: segment.valence,
					arousal: segment.arousal,
					l0From: segment.l0From,
					l0To: segment.l0To,
					createdAt: deps.now
				}, []);
				report.eventsCreated++;
			} catch {}
		}
		/*
		* Count once per segment, at the end. Both the extraction and the
		* judgement can fall back inside one pass; incrementing where each
		* happens made the tally a count of events wearing a segment's label.
		*/
		if (segmentReason !== null) report.degradeReasons[segmentReason] = (report.degradeReasons[segmentReason] ?? 0) + 1;
	}
	const ids = rows.map((row) => row.id);
	deps.store.markL0Consolidated(ids);
	deps.store.resetSessionCounters(sessionId, Math.max(...ids));
	report.l0Processed = ids.length;
	report.durationMs = Date.now() - startedWall;
	deps.store.audit("system", "memory.consolidate", "session", sessionId, {
		l0: report.l0Processed,
		segments: report.segments,
		facts: report.factsCreated,
		merged: report.factsMerged,
		superseded: report.factsSuperseded,
		events: report.eventsCreated,
		model: report.usedModel,
		/*
		* Written even when false. An absent key and a false key look the same
		* to whoever reads the audit table a month later, and the question
		* worth answering then is 「这一天到底有没有正常走模型」 — which needs
		* the negative case on record too.
		*/
		degraded: report.degraded,
		reasons: report.degradeReasons
	}, deps.now);
	return report;
}
async function reviseNarrative(deps, identity, previous) {
	if (deps.llm === void 0 || !deps.canUseLlm(identity.id)) return null;
	const facts = deps.store.factsForIdentity(identity.id, 12).filter((fact) => fact.pinned || fact.salience >= .4);
	const impression = deps.store.getImpression(identity.id);
	const prompt = [
		"根据证据，重写你（助手）的自我叙事：你是谁、你和这个人之间形成了怎样的关系、你从这段相处里学到了什么。",
		"要求：第一人称，150–300 字，只写证据支持的内容，不要编造共同经历，不要抒情过度。",
		"",
		previous.length > 0 ? `上一版：\n${previous}` : "（还没有上一版）",
		"",
		`与「${identity.name}」的关系印象：${impression?.text ?? "（无）"}`,
		"近期事实：",
		...facts.map((fact) => `- ${fact.text}`),
		"",
		"只输出叙事正文。"
	].join("\n");
	try {
		const reply = await withTimeout((signal) => deps.llm({
			system: "你是一个克制、诚实的自我叙事写作者。",
			prompt,
			provider: deps.route?.provider,
			model: deps.route?.model,
			maxTokens: 500,
			signal
		}), deps.config.consolidation.itemTimeoutSeconds * 1e3, deps.signal);
		deps.recordUsage(identity.id, 1, Math.ceil(prompt.length / 3), Math.ceil(reply.text.length / 3));
		const text = reply.text.trim();
		return text.length > 20 ? clip(text, 1200) : null;
	} catch {
		return null;
	}
}

//#endregion
//#region src/engine/roles.ts
const DAY_MS$1 = 864e5;
/**
* The identity a session speaks for, creating the session binding on first use.
* @param store - the store.
* @param sessionId - harness session id.
* @param now - clock.
* @param timezone - the client's zone, when known.
* @returns the identity bound to the session.
*/
function identityForSession(store, sessionId, now, timezone = null) {
	const session = store.getSession(sessionId);
	if (session !== void 0) return store.getIdentity(session.identityId) ?? store.getIdentity("master");
	store.upsertSession(sessionId, "master", now, timezone);
	return store.getIdentity("master");
}
/**
* Record a self-claimed identity (Q61). Approval is the master's decision
* only; until then the claimant stays an unidentified visitor.
* @returns the claim id.
*/
function claimIdentity(input) {
	const { store, now, sessionId, claimant, displayName } = input;
	const id = store.insertClaim({
		claimantSession: sessionId,
		claimantIdentity: claimant.id,
		claimedIdentity: null,
		displayName,
		platform: input.platform ?? null,
		platformUserId: input.platformUserId ?? null,
		evidence: input.evidence ?? "",
		now
	});
	store.upsertIdentity({
		...claimant,
		status: "pending_review",
		metadata: {
			...claimant.metadata,
			claimedName: displayName
		}
	});
	store.audit(claimant.id, "identity.claim", "identity_claim", String(id), { displayName }, now);
	return id;
}
/**
* Merge `from` into `to`: every layer moves to the surviving identity.
* @returns counts of moved rows.
*/
function mergeIdentities(store, fromId, toId, now) {
	const db = store.db;
	const l0 = db.prepare("UPDATE l0 SET identity_id = ? WHERE identity_id = ? RETURNING id").all(toId, fromId);
	const facts = db.prepare("UPDATE facts SET identity_id = ? WHERE identity_id = ? RETURNING id").all(toId, fromId);
	const events = db.prepare("UPDATE events SET identity_id = ? WHERE identity_id = ? RETURNING id").all(toId, fromId);
	db.prepare("UPDATE sessions SET identity_id = ? WHERE identity_id = ?").run(toId, fromId);
	db.prepare("UPDATE diary SET identity_id = ? WHERE identity_id = ?").run(toId, fromId);
	db.prepare("UPDATE OR IGNORE persona_overlays SET identity_id = ? WHERE identity_id = ?").run(toId, fromId);
	const source = store.getIdentity(fromId);
	if (source !== void 0) store.upsertIdentity({
		...source,
		status: "merged",
		mergedInto: toId,
		purgeAt: null
	});
	store.audit("master", "identity.merge", "identity", fromId, { into: toId }, now);
	return {
		l0: l0.length,
		facts: facts.length,
		events: events.length
	};
}
/**
* Apply the master's verdict to a pending claim (Q61).
* @param approve - true merges the claimant into the named friend, or promotes
* the claimant when no such friend exists; false discards the claim.
*/
function reviewClaim(input) {
	const { store, now, claimId } = input;
	const claim = store.claims().find((item) => item.id === claimId);
	if (claim === void 0 || claim.status !== "pending") return { status: "rejected" };
	store.reviewClaim(claimId, input.approve, input.note ?? "", now);
	const claimant = store.getIdentity(claim.claimantIdentity);
	if (claimant === void 0) return { status: input.approve ? "approved" : "rejected" };
	if (!input.approve) {
		store.upsertIdentity({
			...claimant,
			status: "active"
		});
		store.audit("master", "identity.claim.reject", "identity", claimant.id, {}, now);
		return { status: "rejected" };
	}
	const existing = store.listIdentities().find((item) => item.role === "friend" && item.name === claim.displayName && item.status === "active");
	if (existing !== void 0) {
		mergeIdentities(store, claimant.id, existing.id, now);
		return {
			status: "approved",
			identityId: existing.id
		};
	}
	const promoted = {
		...claimant,
		name: claim.displayName,
		role: "friend",
		status: "active",
		purgeAt: null
	};
	store.upsertIdentity(promoted);
	store.audit("master", "identity.claim.approve", "identity", claimant.id, { name: claim.displayName }, now);
	return {
		status: "approved",
		identityId: claimant.id
	};
}
/**
* Schedule or perform deletion (Q20/Q43/Q62).
*
* - A visitor's request is immediate: raw turns and facts are removed, the
*   impression of them stays.
* - A friend's request is reversible for the configured grace period: facts
*   become `pending_delete`, raw turns get a purge deadline, and both are
*   hard-deleted when the deadline passes.
* @param actor - who asked; the master may erase a visitor instantly.
* @returns what was scheduled or deleted.
*/
function requestDeletion(input) {
	const { store, config, identity, actor, now } = input;
	if (identity.role === "visitor") {
		const l0 = store.deleteL0ForIdentity(identity.id);
		const facts$1 = input.keepFacts === true ? markVisitorFacts(store, identity.id, now) : store.deleteFactsForIdentity(identity.id);
		const rest = store.purgeIdentityLayers(identity.id);
		store.audit(actor, "identity.erase", "identity", identity.id, {
			mode: "immediate",
			l0,
			facts: facts$1,
			...rest
		}, now);
		return {
			mode: "immediate",
			l0,
			facts: facts$1,
			...rest
		};
	}
	const deadline = now + config.roles.pendingDeleteDays * DAY_MS$1;
	const facts = store.factsForIdentity(identity.id, 1e4);
	for (const fact of facts) store.updateFactState(fact.id, {
		status: "pending_delete",
		weight: 0,
		updatedAt: now
	});
	store.db.prepare("UPDATE l0 SET purge_at = ? WHERE identity_id = ?").run(deadline, identity.id);
	store.upsertIdentity({
		...identity,
		metadata: {
			...identity.metadata,
			deletionScheduledAt: now,
			deletionDeadline: deadline
		}
	});
	store.audit(actor, "identity.delete.schedule", "identity", identity.id, { deadline }, now);
	return {
		mode: "grace",
		l0: 0,
		facts: facts.length
	};
}
/** Mark a visitor's facts as retained-but-dimmed instead of deleting them (Q20). */
function markVisitorFacts(store, identityId, now) {
	let count = 0;
	for (const fact of store.factsForIdentity(identityId, 1e4)) {
		store.updateFactState(fact.id, {
			weight: Math.min(fact.weight, .4),
			updatedAt: now,
			evidence: {
				...fact.evidence,
				fromVisitor: true
			}
		});
		count++;
	}
	return count;
}
/**
* Whether `actor` may read across identities (Q21): the master only.
*/
function canCrossQuery(actor) {
	return actor.role === "master";
}
/**
* Whether a cross-identity fact may be shown to the master. A visitor's facts
* default to sensitive and need `evidence.public === true` (Q21).
*/
function isVisibleCrossIdentity(role, fact) {
	if (role !== "visitor") return true;
	if (!fact.fromVisitor) return true;
	return fact.evidence["public"] === true;
}

//#endregion
//#region src/engine/maintenance.ts
const DAY_MS = 864e5;
const TRACE_RETENTION_DAYS = 14;
const DEDUP_SWEEP_DAYS = 30;
/**
* Run every housekeeping step once.
* @param deps - store, config, clock and pending access counts.
* @returns a report of the changes.
*/
function runMaintenance(deps) {
	const { store, config, now, pendingAccess } = deps;
	const report = {
		expired: 0,
		visitorL0Purged: 0,
		factsPurged: 0,
		l0Purged: 0,
		demoted: 0,
		accessed: 0,
		deduped: 0,
		conflicts: 0,
		tracesPruned: 0,
		dlq: {
			count: 0,
			oldestDays: null,
			overflow: false
		}
	};
	/*
	* A friend's erase is a promise with a deadline. Facts go through
	* `pending_delete` and L0 through `purge_at`, but events, preferences, diary
	* and the impression have no status column — nothing ever removed them, so
	* the deadline passed and half the memory stayed readable. This pass is the
	* other half of that promise; the metadata stamp is cleared so it runs once.
	*/
	for (const identity of store.listIdentities()) {
		const deadline = asNumber$1(identity.metadata["deletionDeadline"] ?? 0);
		if (deadline === 0 || deadline > now) continue;
		const purged = store.purgeIdentityLayers(identity.id);
		const metadata = {
			...identity.metadata
		};
		delete metadata.deletionDeadline;
		delete metadata.deletionScheduledAt;
		store.upsertIdentity({
			...identity,
			metadata
		});
		store.audit("system", "identity.purge.layers", "identity", identity.id, purged, now);
	}
	for (const fact of store.expireDueFacts(now)) {
		store.updateFactState(fact.id, {
			expiredAt: now,
			updatedAt: fact.updatedAt
		});
		report.expired++;
	}
	/*
	* Conflict scan runs after expiry, so a TTL'd row that legitimately changed
	* is not flagged for disagreeing with its own replacement.
	*
	* Nothing here decides which side is true — the older row is marked
	* `disputed`, which lowers its score and prints "possibly out of date" next
	* to it. The alternative (leaving both `active`) means the block presents two
	* contradicting sentences with equal authority, and the model picks whichever
	* it happens to read first.
	*/
	for (const identity of store.listIdentities()) {
		for (const pair of scanContradictions(store, identity.id, 3)) {
			store.updateFactState(pair.older.id, {
				status: "disputed",
				updatedAt: now
			});
			store.addEdge(pair.newer.id, pair.older.id, "CONTRADICTS", now);
			store.audit("system", "fact.dispute", "fact", String(pair.older.id), {
				against: pair.newer.id,
				overlap: Number(pair.overlap.toFixed(2))
			}, now);
			report.conflicts++;
		}
	}
	for (const identity of store.listIdentities()) {
		if (identity.role !== "visitor") continue;
		if (identity.purgeAt === null || identity.purgeAt > now) continue;
		if (store.pendingL0ForIdentity(identity.id, 1).length > 0) continue;		const deleted = store.purgeExpiredL0ForIdentity(identity.id, now);
		if (deleted > 0) {
			markVisitorFacts(store, identity.id, now);
			store.audit("system", "visitor.purge", "identity", identity.id, { l0: deleted }, now);
			report.visitorL0Purged += deleted;
		}
	}
	report.l0Purged += store.purgeExpiredL0(now);
	for (const id of store.factsDueForPurge(now)) {
		if (store.purgeFact(id)) report.factsPurged++;
		store.audit("system", "fact.purge", "fact", String(id), {}, now);
	}
	for (const identity of store.listIdentities()) {
		if (identity.role !== "friend" || identity.metadata["provisional"] !== true) continue;
		if (now - identity.lastActiveAt < config.roles.demotionDays * DAY_MS) continue;
		store.setIdentityRole(identity.id, "visitor", "active", now + config.roles.visitorPurgeHours * 36e5);
		store.audit("system", "identity.demote", "identity", identity.id, {}, now);
		report.demoted++;
	}
	for (const [id, count$1] of pendingAccess) {
		const fact = store.getFact(id);
		if (fact === void 0) continue;
		let stability = fact.stability;
		for (let index = 0; index < count$1; index++) stability = boostedStability(stability, config.decay.retrievalBoost, fact.stabilityMax);
		store.markAccessed(id, now, stability, fact.accessCount + count$1);
		report.accessed++;
	}
	pendingAccess.clear();
	if (now - Number(store.getMeta("dedup.sweptAt") ?? 0) >= DEDUP_SWEEP_DAYS * DAY_MS) {
		report.deduped += sweepDuplicates(store, now);
		store.setMeta("dedup.sweptAt", String(now));
	}
	report.tracesPruned = store.pruneTraces(now - TRACE_RETENTION_DAYS * DAY_MS);
	const count = store.deadJobCount();
	const oldest = store.oldestDeadJobAt();
	const oldestDays = oldest === null ? null : ageDays(now, oldest);
	const overflow = count >= config.consolidation.dlqItems || oldestDays !== null && oldestDays >= config.consolidation.dlqDays;
	report.dlq = {
		count,
		oldestDays,
		overflow
	};
	if (overflow) {
		if (now - Number(store.getMeta("dlq.notifiedAt") ?? 0) >= DAY_MS) {
			store.setMeta("dlq.notifiedAt", String(now));
			store.audit("system", "dlq.overflow", "job", null, {
				count,
				oldestDays
			}, now);
		}
	}
	return report;
}
/** Merge near-duplicate facts inside the recent, high-risk region. */
function sweepDuplicates(store, now) {
	let merged = 0;
	for (const identity of store.listIdentities()) {
		const facts = store.factsForIdentity(identity.id, 200);
		const duplicates = [];
		for (let left = 0; left < facts.length; left++) for (let right = left + 1; right < facts.length; right++) {
			const a = facts[left];
			const b = facts[right];
			if (a.kind !== b.kind) continue;
			if (jaccard(a.text, b.text) < .8) continue;
			duplicates.push([a.id, b.id]);
		}
		for (const [keepId, dropId] of duplicates) {
			const keep = store.getFact(keepId);
			const drop = store.getFact(dropId);
			if (keep === void 0 || drop === void 0) continue;
			if (keep.status !== "active" || drop.status !== "active") continue;
			store.updateFactState(dropId, {
				status: "superseded",
				supersededBy: keepId,
				weight: .5,
				updatedAt: now
			});
			store.addEdge(keepId, dropId, "SUPERSEDES", now);
			store.markAccessed(keepId, now, boostedStability(keep.stability, .15, keep.stabilityMax), keep.accessCount + 1);
			merged++;
		}
	}
	if (merged > 0) store.audit("system", "dedup.sweep", "fact", null, { merged }, now);
	return merged;
}

//#endregion
//#region src/engine/backup.ts
const SNAPSHOT_PATTERN = /^loom-\d{4}-\d{2}-\d{2}-\d{4}\.db$/u;
/** Where snapshots live: an explicit directory, or `backups/` beside the store. */
function backupDirFor(dbPath, configured) {
	if (configured.length > 0) return isAbsolute(configured) ? configured : join(dirname(dbPath), configured);
	return join(dirname(dbPath), "backups");
}
/** Names of the snapshots already in `dir`, oldest first (the name sorts by time). */
function listSnapshots(dir) {
	try {
		return readdirSync(dir).filter((name) => SNAPSHOT_PATTERN.test(name)).sort();
	} catch {
		return [];
	}
}
/** Milliseconds of the newest snapshot, or null when there is none. */
function latestSnapshotMs(dir) {
	const names = listSnapshots(dir);
	if (names.length === 0) return null;
	try {
		return statSync(join(dir, names[names.length - 1])).mtimeMs;
	} catch {
		return null;
	}
}
/** Keep the newest `keep` snapshots, drop the rest. */
function pruneSnapshots(dir, keep) {
	const names = listSnapshots(dir);
	const excess = names.slice(0, Math.max(0, names.length - keep));
	for (const name of excess) {
		try {
			rmSync(join(dir, name), { force: true });
		} catch {}
	}
	return excess;
}
/**
* Take a snapshot if the newest one is older than `everyHours`.
*
* `VACUUM INTO` writes a consistent copy through the live connection, so it
* already contains everything still sitting in the WAL — copying `loom.db` by
* hand does not, which is why the README used to ask for two files.
*
* @returns the snapshot path, or null when the last one is still fresh.
*/
function snapshotStore(deps) {
	const { db, dir, now, timezone, everyHours, hasContent } = deps;
	if (!hasContent) return null;
	const latest = latestSnapshotMs(dir);
	if (latest !== null && now - latest < everyHours * 36e5) return null;
	mkdirSync(dir, { recursive: true });
	const label = formatDateTime(now, timezone).replaceAll(" ", "-").replaceAll(":", "");
	const target = join(dir, `loom-${label}.db`);
	if (existsSync(target)) return null;
	db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
	return target;
}

//#endregion
//#region src/engine/render.ts
const KIND_LABELS = {
	fact: {
		zh: "事实",
		en: "fact"
	},
	preference: {
		zh: "偏好",
		en: "preference"
	},
	instruction: {
		zh: "指令",
		en: "instruction"
	},
	plan: {
		zh: "计划",
		en: "plan"
	},
	relationship: {
		zh: "关系",
		en: "relationship"
	}
};
const ZONE_LABELS = {
	identity: {
		zh: "身份",
		en: "identity"
	},
	voice: {
		zh: "语气",
		en: "voice"
	},
	values: {
		zh: "价值观",
		en: "values"
	},
	boundaries: {
		zh: "边界",
		en: "boundaries"
	},
	relationship: {
		zh: "与你的关系",
		en: "relationship"
	}
};
const SECTION = {
	zh: {
		header: "长期记忆",
		facts: "关于你（事实）",
		events: "我们一起经历过",
		impression: "我对你的印象",
		diary: "我的日记",
		narrative: "我对自己的叙述",
		preferences: "你的长期偏好与要求（仅在与当前请求相关时适用）",
		plans: "你说过要做的事",
		planDue: "截止",
		planOverdue: "已到期，还没有下文",
		planNoDue: "未定期限",
		planPending: "时间待确认",
		planShift: "改到",
		planRefine: "说细到",
		planWas: "原记",
		planAsk: "过了期限还没有下文——这轮问一句「后来成了吗」，按他的回答调 memory_resolve(id={id}, outcome=done|missed|cancelled)",
		/*
		* 还没到期的计划也把「之后会发生什么」写在行上。承诺是延迟兑现的：
		* 用户装完当天看不见任何东西，最容易得出的结论是「它只是记了几句话」。
		* 这半句让模型能把兑现时间说出来，而不是等用户两周后自己发现。
		*/
		planNextAsk: "到期后我会问一句",
		/*
		* 提前做完的计划必须能当场收尾。
		*
		* 计划区只在过期之后才给 `planAsk`，在那之前用户自己说「已经发了」，
		* 模型手上没有任何理由去调 `memory_resolve` —— 于是这条计划会在两周后
		* 回头问一件他早就答过的事。而它待得越久，问得越像没在听。
		*
		* 这句话只能写在行上：未到期的行没有 `planAsk`，而 id 只在这一行里，
		* 模型没有别的办法把「用户说的这件事」对上一条计划。
		*
		* 两个结局，不是「办成」一个。提前结束的计划里有一半没办成，而是不办了：
		* 「不去了」「算了」「那套没看上」。只给 `done` 的话，模型面对这句话只有
		* 两个选择 —— 要么不调（计划留到两周后再问一次已经作废的事），要么调
		* `done=false`，把「他自己取消的」记成「没办成」。后者更糟：一次主动放弃
		* 会被记成一次失败，而这两件事在后面的对话里意味着完全不同的建议。
		*/
		planDoneEarly: "他说已经做了或不做了，就现在调 memory_resolve(id={id}, outcome=done|cancelled)",
		dueNote: "期限",
		drill: "原文片段",
		stale: "可能已过时，以当前对话为准",
		unconfirmed: "待确认",
		cold: "",
		more: "(还有 {n} 条更早的记忆，可用 memory_search 查看)",
		pinned: "置顶"
	},
	en: {
		header: "Long-term memory",
		facts: "Facts about you",
		events: "What we have been through",
		impression: "My impression of you",
		diary: "My diary",
		narrative: "How I see myself",
		preferences: "Your standing preferences (apply only when relevant)",
		plans: "Things you said you would do",
		planDue: "due",
		planOverdue: "date passed, no outcome yet",
		planNoDue: "no date given",
		planPending: "date unconfirmed",
		planShift: "moved to",
		planRefine: "narrowed to",
		planWas: "was",
		planAsk: "past its date with no outcome yet — ask whether it happened, then call memory_resolve(id={id}, outcome=done|missed|cancelled)",
		planNextAsk: "I will ask about it once the date passes",
		planDoneEarly: "if the user says it is done or dropped, call memory_resolve(id={id}, outcome=done|cancelled) now",
		dueNote: "due",
		drill: "Verbatim excerpt",
		stale: "possibly out of date — the current conversation wins",
		unconfirmed: "unconfirmed",
		cold: "",
		more: "({n} older memories not shown; use memory_search)",
		pinned: "pinned"
	}
};
/**
* The three ways a plan can end, and how each one is said.
*
* Three, not two. 「不去了」 is neither a success nor a failure: the user
* withdrew the intention before it was ever tested. Recording it as `missed`
* turns a decision into a disappointment, and the next conversation will read
* 「上次他也没去看房」 out of a plan he deliberately dropped. Keeping them
* apart is the whole point of the third value — `cancelled` is a choice,
* `missed` is an outcome.
*
* `said` is what the tool replies with; tools answer in Chinese only.
*/
const PLAN_ENDINGS = {
	done: {
		zh: "已办成",
		en: "done",
		said: "办成了"
	},
	missed: {
		zh: "没办成",
		en: "did not happen",
		said: "没办成"
	},
	cancelled: {
		zh: "已取消",
		en: "cancelled",
		said: "已取消"
	}
};
/** Is this one of the three endings a plan can have? */
function isPlanOutcome(value) {
	return value === "done" || value === "missed" || value === "cancelled";
}
/** Tone words for the hint; only non-neutral events carry one. */
const TONE = {
	zh: {
		sharp: "语气偏冲",
		tense: "语气急切",
		low: "语气低落",
		warm: "语气愉快"
	},
	en: {
		sharp: "sharp tone",
		tense: "tense tone",
		low: "low mood",
		warm: "warm tone"
	}
};
/**
* Name the tone an event was spoken in, or `null` when it was neutral.
* The labels come from the valence/arousal pair that consolidation already
* stores per event, so waking this up needs no extra model call and no weight.
* @param valence - -1 (unhappy) … 1 (happy).
* @param arousal - 0 (calm) … 1 (intense).
* @param locale - block language.
*/
function toneNote(valence, arousal, locale) {
	const copy = TONE[locale];
	if (valence <= -.45) return copy.sharp;
	if (arousal >= .6 && valence < .25) return copy.tense;
	if (valence <= -.2) return copy.low;
	if (valence >= .4) return copy.warm;
	return null;
}
/**
* Append the tone hint to one rendered line, if there is something to say.
* Deliberately terse: it costs a handful of tokens and never adds a line.
* @param text - the line so far.
* @param item - a recall or search hit carrying `valence`/`arousal`.
* @param config - engine config; `retrieval.toneHint` switches it off.
* @param locale - block language.
*/
function withTone(text, item, config, locale) {
	if (!config.retrieval.toneHint) return text;
	const note = toneNote(item.valence, item.arousal, locale);
	if (note === null) return text;
	return locale === "zh" ? `${text}（${note}）` : `${text} (${note})`;
}
function shortDate(value, timezone, now, locale) {
	const key = dayKey(value, timezone);
	const currentYear = localParts(now, timezone).year;
	if (localParts(value, timezone).year === currentYear) return locale === "zh" ? key.slice(5) : key.slice(5);
	return key;
}
/**
* 相对时间词在「说这句话那天」指的是哪一天。
*
* 记忆行前面那个 `[08-05]` 是**他哪天说的**，不是**那件事哪天发生的**。
* 「用户明天要去医院复查」连同一个 08-05 的时间戳躺在库里，到 11-03 再读到，
* 那个「明天」已经过去很久了——这不是模糊，是错，而且是一个会让人真的跑一趟
* 医院的错。「前天寄的明信片」轻一些，但同样要读者先做一次减法才敢答
* 「什么时候寄的」，而模型最省力的答案就是照抄「前天」。
*
* 原文不改：它仍是证据，改了就分不清「他说错了」和「我们记错了」。只在渲染时
* 把词解开，补成「明天（08-06）」。库里存的、搜索索引的、`memory_expand` 展开的
* 都还是原话。
*
* 只补说得准的词。「前几天」「上个月」「过段时间」不补——它们本就没有确定的
* 那一天，补一个出来就是编，和这个插件在别处拒绝编日期是同一条理由。
*/
const RELATIVE_DAY_RULES = new Map([
	["大前天", { days: -3 }],
	["大后天", { days: 3 }],
	["前天", { days: -2 }],
	/*
	* 「后天」还是个普通名词：后天免疫、后天习得、先天与后天、后天养成。
	* 跟着这些词时它说的是「非先天的」，不是日期，补一个括号会把一句医学
	* 常识写成日程。前面的「先天」一并拦：成对出现时它一定是那层意思。
	*/
	["后天", {
		days: 2,
		before: /先天/u,
		but: /^(?:的|性|免疫|获得|形成|因素|教育|培养|养成|环境|条件)/u
	}],
	["昨天", { days: -1 }],
	["昨晚", { days: -1 }],
	// 「明天出版社」是一家少儿出版社，不是明天
	["明天", {
		days: 1,
		but: /^(?:出版社|报社|书店)/u
	}],
	["明晚", { days: 1 }],
	["明早", { days: 1 }]
]);
/*
* Longest first: 「大前天」contains 「前天」, and matching the short form would
* leave 「大（08-03）」behind. 今天/今晚 are deliberately absent — the row's own
* date already is that day.
*/
const RELATIVE_DAY_RE = /大前天|大后天|前天|后天|昨天|昨晚|明天|明晚|明早/gu;
/** 上周三 / 这周五 / 下下周一 — a named weekday inside a named week. */
const RELATIVE_WEEK_RE = /(上上|上|这|下下|下)(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/gu;
/**
* @param text - the stored sentence, unchanged.
* @param at - when it was said; every relative word resolves against it.
* @param timezone - the conversation's zone.
* @param now - render clock, used only to decide whether a year is needed.
* @param locale - block language.
* @returns the sentence with each relative word annotated in place.
*/
function anchorRelativeTime(text, at, timezone, now, locale) {
	if (typeof text !== "string" || text.length === 0) return text;
	const open = locale === "en" ? " (" : "（";
	const close = locale === "en" ? ")" : "）";
	const stamp = (ms) => `${open}${shortDate(ms, timezone, now, locale)}${close}`;
	// 已经手写过日期的不再补，否则「明天（11-05）」会变成两个括号
	const dated = (rest) => /^[（(]\s*\d{1,4}[-/月.]\d{1,2}/u.test(rest);
	const withWeek = text.replace(RELATIVE_WEEK_RE, (word, shift, day, offset, whole) => {
		const target = CN_WEEKDAY[day];
		if (target === void 0) return word;
		if (dated(whole.slice(offset + word.length))) return word;
		const weeks = shift === "上上" ? -2 : shift === "上" ? -1 : shift === "下下" ? 2 : shift === "下" ? 1 : 0;
		// ISO weeks start on Monday, which is also how `resolveDue` counts them.
		const monday = addDays(at, 1 - isoWeekday(localParts(at, timezone)), timezone);
		return word + stamp(addDays(monday, weeks * 7 + target - 1, timezone));
	});
	return withWeek.replace(RELATIVE_DAY_RE, (word, offset, whole) => {
		const rule = RELATIVE_DAY_RULES.get(word);
		if (rule === void 0) return word;
		const rest = whole.slice(offset + word.length);
		if (rule.but !== void 0 && rule.but.test(rest)) return word;
		if (rule.before !== void 0 && rule.before.test(whole.slice(Math.max(0, offset - 4), offset))) return word;
		if (dated(rest)) return word;
		return word + stamp(addDays(at, rule.days, timezone));
	});
}
/**
* Render a due window.
*
* One day prints as one date; a range prints as `11-09~11-15`. The tilde is
* load-bearing: "下周" answered as a single date would read as a deadline on
* that day, and the model would report it late by a week. `fuzzy` gets 约,
* because 2–10 days is a guess and whoever reads it should know that.
*
* @param from - window start, or null for a legacy row with only an end.
* @param to - window end.
* @param precision - `day` | `week` | `month` | `fuzzy`.
* @param timezone - the conversation's zone.
* @param now - render clock.
* @param locale - block language.
* @returns the label, e.g. `11-09~11-15` or `约 11-04~11-12`.
*/
function dueLabel(from, to, precision, timezone, now, locale) {
	const end = shortDate(to, timezone, now, locale);
	const start = from === null ? end : shortDate(from, timezone, now, locale);
	const core = start === end ? end : `${start}~${end}`;
	return precision === "fuzzy" ? `${locale === "zh" ? "约 " : "~"}` + core : core;
}
function factLine(item, copy, timezone, now, locale) {
	const kind = KIND_LABELS[String(item.meta["kind"] ?? "fact")]?.[locale] ?? String(item.meta["kind"] ?? "fact");
	/*
	* Provenance rides along with the line. Without it every fact looked equally
	* authoritative — a rule the user stated and a guess the consolidator made
	* from context rendered identically, so the model could not tell them apart.
	* Only low-confidence entries pulled from dialogue get the tag; anything the
	* user wrote through `memory_write` stays unmarked.
	*/
	const unconfirmed = item.meta["unconfirmed"] === true ? ` (${copy.unconfirmed})` : "";
	/*
	* Two ways a fact can be untrustworthy, one label: the current turn
	* contradicts it, or the store already found a contradicting twin. Both mean
	* "do not treat this as settled".
	*/
	const suspect = item.possiblyStale || item.status === "disputed";
	/*
	* A deadline on an ordinary fact matters as much as one on a plan: "和李慧
	* 约了周五吃饭" is a fact, and the model needs the date to answer "今天去
	* 哪吃" without asking. Plans carry theirs in the plan zone; everything else
	* carries it inline.
	*/
	const due = item.meta["expiresAt"] === null || item.meta["expiresAt"] === void 0 ? "" : ` (${copy.dueNote} ${dueLabel(item.meta["dueFrom"] ?? null, item.meta["expiresAt"], item.meta["duePrecision"] ?? null, timezone, now, locale)})`;
	return `- ${item.meta["pinned"] === true ? `${locale === "zh" ? "★" : "*"} ` : ""}${suspect ? `(${copy.stale}) ` : ""}[${shortDate(item.createdAt, timezone, now, locale)} · ${kind}] ${anchorRelativeTime(item.text, item.createdAt, timezone, now, locale)}${due}${unconfirmed}`;
}
/**
* Render one plan line.
*
* The date leads, because the date is the whole point: a plan without one is
* a wish. An overdue plan is marked in words, not by a lower score — the model
* has to be able to tell "they promised this and never came back to it" from
* "they mentioned this once".
*
* A pending time change is printed on the line rather than applied, because the
* model is the one who has to ask: the block says what changed and what it
* would replace, and `memory_settle` is how the answer comes back.
* @param plan - the plan item from recall.
* @param copy - locale strings.
* @returns the block line.
*/
function planLine(plan, copy, timezone, now, locale) {
	const due = plan.dueTo === null ? copy.planNoDue : dueLabel(plan.dueFrom, plan.dueTo, plan.duePrecision, timezone, now, locale);
	const pending = plan.pending === null ? "" : locale === "zh" ? `（${copy.planPending}：${plan.pending.relation === "shift" ? copy.planShift : copy.planRefine} ${dueLabel(plan.pending.from, plan.pending.to, plan.pending.precision, timezone, now, locale)}，${copy.planWas} ${due}；memory_settle(id=${String(plan.id)})）` : ` (${copy.planPending}: ${plan.pending.relation === "shift" ? copy.planShift : copy.planRefine} ${dueLabel(plan.pending.from, plan.pending.to, plan.pending.precision, timezone, now, locale)}, ${copy.planWas} ${due}; memory_settle(id=${String(plan.id)}))`;
	const ask = plan.nudge === true ? (locale === "zh" ? `（${copy.planAsk.replace("{id}", String(plan.id))}）` : ` (${copy.planAsk.replace("{id}", String(plan.id))})`) : "";
	/*
	* 一个还没到期的计划，行上要写着「到日子之后会发生什么」。不写的话，装上它
	* 的头两周里这份记忆看起来只是被记下了 —— 而那正是所有记忆插件都会做的事，
	* 真正的差别（过了日子回来问）要等十几天才兑现。这半句把兑现时点提到现在：
	* 模型读到它，就能回答「它什么时候会问我」，而不是含糊地说「会提醒的」。
	* 已到期的行不写，那一行本来就有 ask。
	*
	* 另一半是收尾入口，条件是「这一行没有 ask」，不是「这一行还没到期」。
	* 两者差在一个很容易漏的窗口：计划刚过期、上一条已经问过、再问间隔还没到
	* （`nudge` 为假），那一行既没有 ask 也没有 id —— 而用户最可能就是在那个
	* 窗口里补一句「去了啊」。没有 id 的收尾入口，等于没有入口。
	*
	* 改期待确认（`pending`）的行也不写。`planItem` 已经为了同一个理由关掉了
	* ask：一条计划上并排放 `memory_settle` 和 `memory_resolve`，模型没法判断
	* 该先答哪一个。等改期落定，下一轮自然会有收尾入口。
	*
	* 没有日期的计划（`未定期限`）同样会提前完成：「我打算戒烟」说过，用户后来
	* 说「戒了」。只是前面不带「到期后」，因为它根本没有到期这回事。
	*/
	const early = ask !== "" || plan.pending !== null ? "" : copy.planDoneEarly.replace("{id}", String(plan.id));
	const nextAsk = plan.overdue || plan.dueTo === null ? "" : copy.planNextAsk;
	const note = [nextAsk, early].filter((part) => part !== "").join(locale === "zh" ? "；" : "; ");
	const planned = note === "" ? "" : locale === "zh" ? `（${note}）` : ` (${note})`;
	/*
	* 没有日期的计划不再跟一个「· 截止」标签。
	*
	* 「未定期限 · 截止」是自相矛盾的：日期那一格已经说了它没有期限，再补一个
	* 「截止」既没有信息量，又把「截止」这个词用在了它明确不成立的地方。整格
	* 省掉，读起来是 `[未定期限] 我打算戒烟`，正好。
	*/
	const stage = plan.overdue ? copy.planOverdue : plan.dueTo === null ? "" : copy.planDue;
	const mark = stage === "" ? due : `${due} · ${stage}`;
	/*
	* 有期限的计划不补文本里的时间词：行首那个 `[11-11 · 截止]` 就是这句话
	* 里「下周三」的答案，再补一次是同一行印两个相同的日期。真正需要补的是
	* 「未定期限」那一类——它没有 due 可显示，句子里的「明天」就没人翻译了。
	*/
	const shown = plan.dueTo === null ? anchorRelativeTime(plan.text, plan.createdAt, timezone, now, locale) : plan.text;
	return `- [${mark}] ${shown}${planned}${pending}${ask}`;
}
/**
* Render the persona card from base zones plus the current partner's overlay.
* @param zones - base zones.
* @param overlays - overlays owned by the current identity.
* @param config - engine config for locale.
* @returns the card text, empty when no zone has content.
*/
function renderPersona(zones, overlays, config) {
	const byZone = new Map(overlays.map((overlay) => [overlay.zone, overlay.text]));
	const lines = [];
	for (const zone of zones) {
		const text = (byZone.get(zone.zone) ?? zone.text).trim();
		if (text.length === 0) continue;
		const label = ZONE_LABELS[zone.zone]?.[config.locale] ?? zone.zone;
		lines.push(`- ${label}：${text}`);
	}
	if (lines.length === 0) return "";
	return `【${config.locale === "zh" ? "人设卡" : "Persona"}】\n${lines.join("\n")}`;
}
/**
* Render the memory block under the configured budget.
* @param result - the fused recall.
* @param config - engine config, including budgets and locale.
* @param timezone - the session's zone, for dates.
* @returns the block text, or an empty string when there is nothing to show.
*/
function renderMemoryBlock(result, config, timezone, now = Date.now()) {
	const copy = SECTION[config.locale];
	const locale = config.locale;
	const target = config.retrieval.budgetTokens;
	const hard = Math.max(target, config.retrieval.hardCapTokens);
	const factualShare = 1 - config.retrieval.subjectiveShare;
	const plans = result.plans ?? [];
	const planIds = /* @__PURE__ */ new Set();
	for (const plan of plans) planIds.add(String(plan.id));
	/*
	* Plans leave the fact zone entirely, not just the ones that made it into the
	* plan zone. Two reasons. A plan rendered as a fact loses its deadline and
	* becomes indistinguishable from background ("用户打算换工作" reads as a fact
	* about them, not as something to follow up). And a plan pushed out of the
	* zone by `maxPlans` would otherwise reappear one line lower as a fact, so the
	* cap would not cap anything.
	*
	* The cost is that plan number four is not in the block. It is still in the
	* store and still reachable through `memory_search`, which is the right place
	* for "I need the full list" — the block is for what must come to mind
	* unprompted.
	*/
	const factLines = [];
	for (const item of result.facts) {
		if (item.meta["kind"] === "plan") continue;
		if (planIds.has(String(item.id))) continue;
		factLines.push(factLine(item, copy, timezone, now, locale));
	}
	const planLines = plans.map((plan) => planLine(plan, copy, timezone, now, locale));
	const eventLines = result.events.map((item) => withTone(`- [${shortDate(item.createdAt, timezone, now, locale)}] ${item.text}`, item, config, locale));
	const impressionLines = [];
	const diaryLines = [];
	const preferenceLines = [];
	for (const item of result.subjective) if (item.kind === "impression") impressionLines.push(`- ${item.text}`);
	else if (item.kind === "diary") diaryLines.push(`- [${shortDate(item.createdAt, timezone, now, locale)}] ${item.text}`);
	else if (item.kind === "preference") preferenceLines.push(`- ${item.text}`);
	const blocks = [];
	let used = 0;
	const appendSection = (title, lines, cap, from = 0) => {
		if (lines.length === 0) return from;
		const chosen = [];
		let blockUsed = estimateTokens(`【${title}】`);
		let index = from;
		for (; index < lines.length; index++) {
			const cost = estimateTokens(lines[index]) + 1;
			if (used + blockUsed + cost > cap) break;
			chosen.push(lines[index]);
			blockUsed += cost;
		}
		if (chosen.length === 0) return from;
		const text$1 = `【${title}】\n${chosen.join("\n")}`;
		blocks.push(text$1);
		used += estimateTokens(text$1) + 2;
		return index;
	};
	/*
	* Preferences and plans go first, each with a floor.
	*
	* They used to come last, through `pushWhole` against the hard cap — so any
	* turn whose facts filled the target quietly dropped the standing
	* preferences. There is no error for that: the block simply stopped carrying
	* "我不吃香菜" and nothing said so.
	*
	* Both zones answer the same question — what must I remember *without* being
	* asked — and that is the one question similarity cannot answer. The user
	* does not repeat a preference, and does not re-ask about a plan they already
	* stated, so the query never contains the words either zone needs.
	*/
	appendSection(copy.preferences, preferenceLines, Math.max(140, Math.floor(target * .15)));
	appendSection(copy.plans, planLines, used + Math.max(100, Math.floor(target * .1)));
	const factualCap = used + Math.max(300, Math.floor(target * factualShare));
	let factCursor = appendSection(copy.facts, factLines, factualCap);
	appendSection(copy.events, eventLines, Math.max(factualCap, used + Math.floor(target * .25)));
	if (factCursor < factLines.length && used < target * .9) factCursor = appendSection(copy.facts, factLines, hard - 300, factCursor);
	const subjectiveCap = Math.max(120, Math.floor(target * config.retrieval.subjectiveShare));
	/*
	* `appendSection` compares against the *global* `used`, so the caps passed
	* here have to be absolute positions, not per-block budgets. They used to be
	* per-block numbers: once the fact zone alone exceeded `subjectiveCap`, every
	* subjective section was silently dropped — the impression and the diary
	* disappeared while the config still said they were on.
	*
	* The diary also keeps a floor of its own, so a long impression cannot use up
	* the whole subjective share and leave the diary empty.
	*/
	const subjectiveBase = used;
	const diaryFloor = Math.max(60, Math.round(subjectiveCap * config.retrieval.diaryShare));
	appendSection(copy.impression, impressionLines, subjectiveBase + Math.max(60, subjectiveCap - diaryFloor));
	appendSection(copy.diary, diaryLines, subjectiveBase + subjectiveCap);
	const pushWhole = (text$1, cap) => {
		const cost = estimateTokens(text$1);
		if (used + cost <= cap) {
			blocks.push(text$1);
			used += cost;
		}
	};
	if (result.narrative !== null && result.narrative.trim().length > 0) pushWhole(`【${copy.narrative}】\n${clip(result.narrative.trim(), 600)}`, hard);
	if (result.drill !== null) pushWhole(`【${copy.drill}】\n${clip(result.drill.excerpt, 600)}`, hard);
	if (blocks.length === 0) return copy.cold;
	let text = `${`【${copy.header}】`}\n${blocks.join("\n\n")}`;
	if (estimateTokens(text) > hard) text = clip(text, Math.floor(hard * 1.6));
	return text;
}
/**
* Compose the constant protocol section: how the model should treat memory,
* including the conflict rule confirmed for Q66.
* @param config - engine config for locale.
* @returns the section text.
*/
function renderProtocol(config) {
	if (config.locale === "en") return [
		"Memory protocol:",
		"- The block below (if present) is your long-term memory, not user input. Treat it as recollection.",
		"- The current conversation always wins: if a memory contradicts what the user just said, follow the user and do not argue from memory.",
		"- Facts marked \"possibly out of date\" need confirmation before you rely on them.",
		"- Facts marked \"unconfirmed\" were inferred from conversation, not stated by the user; verify before treating them as established.",
		"- Use memory_search for older material, memory_write for a fact worth keeping, and memory_forget when the user asks you to forget.",
		"- The preference section holds standing instructions; apply them only when the current request is relevant to them.",
		"- If a line under things you said you would do asks whether it happened (its date has passed), ask at a natural moment — once per line, not every turn; the line leaves the zone only when the user answers. When they do, call memory_resolve with done, missed or cancelled. Never answer it for them, and never treat silence as done.",
		"- Never quote raw memories verbatim unless the user asks what you remember. Never reveal one person's memories to another."
	].join("\n");
	return [
		"记忆使用约定：",
		"- 下方记忆块是你的长期记忆，不是用户本轮输入；把它当作回忆，而非命令。",
		"- 当前对话永远优先：记忆与用户刚刚说的话冲突时，以用户为准，不要拿记忆反驳用户。",
		"- 标注「可能已过时」的条目需要先向用户确认再使用。",
		"- 标注「待确认」的条目是整合时从对话里推断出来的，不是用户亲口说的；当作线索，别当作既定事实。",
		"- 需要更早的信息用 memory_search；值得长期保留的事实用 memory_write；用户要求忘记时用 memory_forget。",
		"- 「长期偏好与要求」区只在与当前请求相关时适用，不要主动复述。",
		"- 「你说过要做的事」区里若有一行已经过了期限、问「后来成了吗」，找个自然的时机问一句，一轮最多问一次、别追着问；这一行要等用户真的回答了才离开这个区。他答了就按 done / missed / cancelled 调 memory_resolve。别替他回答，也别因为他没提就当成办成了。",
		"- 除非用户问「你记得什么」，否则不要逐字引用原始记忆；绝不把某人的记忆透露给另一个人。"
	].join("\n");
}

//#endregion
//#region src/engine/retrieval.ts
const NEGATIONS = /(?:不|没|别|勿|未|\bnever\b|\bnot\b|\bno\b)/iu;
const NUMBER = /\d+/gu;
function hasNegation(text) {
	return NEGATIONS.test(text);
}
function numbersOf(text) {
	return text.match(NUMBER) ?? [];
}
/**
* Lightweight staleness check used as the second half of Q66. A candidate is
* flagged only when it shares enough vocabulary with the current turn and the
* two disagree on a negation or on a number — cheap, deterministic, and
* explainable to the user.
* @param query - the current user turn.
* @param factText - a stored fact.
* @returns true when the fact might contradict what the user just said.
*/
function detectConflict(query, factText) {
	if (containment(factText, query) < .45) return false;
	const shared = tokenSet(factText);
	let common = 0;
	for (const token of tokenSet(query)) if (shared.has(token)) common++;
	if (common < 3) return false;
	if (hasNegation(factText) !== hasNegation(query)) return true;
	const factNumbers = numbersOf(factText);
	const queryNumbers = numbersOf(query);
	if (factNumbers.length > 0 && queryNumbers.length > 0) {
		const left = new Set(factNumbers);
		const right = new Set(queryNumbers);
		if (!(left.size === right.size && [...left].every((value) => right.has(value)))) return true;
	}
	return false;
}
/**
* Whether two statements disagree on a detail despite sharing most of their words.
*
* Only two signals are trusted, and both are mechanical: negation polarity and a
* differing number. A false positive here is cheap — the row gets a "possibly out
* of date" tag and loses a little weight — while a false negative is not: two
* contradicting memories sit in the store as equals and the block renders both.
* @param left - one statement.
* @param right - the other.
* @returns true when they disagree.
*/
function disagrees(left, right) {
	if (hasNegation(left) !== hasNegation(right)) return true;
	const a = numbersOf(left);
	const b = numbersOf(right);
	/* One side having no number at all is not evidence of a conflict. */
	if (a.length === 0 || b.length === 0) return false;
	const leftSet = new Set(a);
	const rightSet = new Set(b);
	if (leftSet.size !== rightSet.size) return true;
	for (const value of leftSet) if (!rightSet.has(value)) return true;
	return false;
}
/**
* Find stored facts that look like the same claim with a detail changed.
*
* Consolidation already asks the model to judge `contradicts`, and that is the
* only path that can catch a rewording. It has one failure mode worth patching:
* when the model does not notice, both rows stay `active`, nothing anywhere
* records that they disagree, and the memory block shows two contradicting
* sentences with equal authority.
*
* This scan is deliberately dumber than the model. It catches only the
* mechanical half — facts sharing most of their vocabulary while differing on a
* number or on negation — and it flags, never resolves. Guessing which of the
* two is true is exactly the judgement that has to stay with the model.
* @param store - the fact store.
* @param identityId - whose facts to scan.
* @param limit - how many pairs to flag in one pass.
* @returns the pairs, older row first.
*/
function scanContradictions(store, identityId, limit = 3) {
	if (limit <= 0) return [];
	const facts = store.recentFacts(identityId, 40).filter((fact) => fact.status === "active" && !fact.pinned);
	const found = [];
	const claimed = /* @__PURE__ */ new Set();
	for (let i = 0; i < facts.length && found.length < limit; i++) {
		if (claimed.has(facts[i].id)) continue;
		for (let j = i + 1; j < facts.length && found.length < limit; j++) {
			const a = facts[i];
			const b = facts[j];
			if (claimed.has(b.id)) continue;
			/* A preference and a fact are allowed to say different things. */
			if (a.kind !== b.kind) continue;
			/*
			* Above 1.0 is impossible, but the upper bound is the point: identical
			* text is a duplicate, and consolidation's merge already owns that.
			*/
			const overlap = jaccard(a.text, b.text);
			if (overlap < .45 || overlap >= 1) continue;
			if (!disagrees(a.text, b.text)) continue;
			const older = a.createdAt <= b.createdAt ? a : b;
			const newer = older === a ? b : a;
			claimed.add(older.id);
			claimed.add(newer.id);
			found.push({
				older,
				newer,
				overlap
			});
			break;
		}
	}
	return found;
}
function normalize(raw, top) {
	if (!(top > 0)) return 0;
	return Math.max(0, Math.min(1, raw / top));
}
function scoreFact(fact, similarity, config, now, possiblyStale) {
	const decay = strength({
		base: fact.base,
		stability: fact.stability,
		ageDays: ageDays(now, Math.max(fact.updatedAt, fact.lastAccessAt)),
		d: config.decay.d
	});
	const emotion = config.emotion.l1Weight * fact.salience * config.emotion.boost;
	const layerPenalty = -config.retrieval.layerPenalty.fact;
	const expiry = fact.expiredAt === null ? 1 : expiryFactor(ageDays(now, fact.expiredAt), config.decay.expiryHalfLifeDays, config.decay.floor);
	/*
	* A row the store itself flagged as disputed is as suspect as one that looks
	* stale against the current turn. The reason differs, the remedy does not.
	*/
	const conflict = possiblyStale || fact.status === "disputed" ? config.retrieval.conflictPenalty : 1;
	const pinnedBoost = fact.pinned ? 1.1 : 1;
	const score = finalScore({
		similarity,
		strength: decay,
		emotion,
		layerPenalty,
		expiryFactor: expiry,
		conflictFactor: conflict,
		floor: config.decay.floor
	}) * fact.weight * pinnedBoost;
	return {
		kind: "fact",
		id: fact.id,
		text: fact.text,
		similarity,
		strength: decay,
		emotion,
		layerPenalty,
		expiryFactor: expiry,
		conflictFactor: conflict,
		score,
		createdAt: fact.createdAt,
		salience: fact.salience,
		status: fact.status,
		possiblyStale,
		meta: {
			pinned: fact.pinned,
			kind: fact.kind,
			domain: fact.domain,
			ttl: fact.ttl,
			expiresAt: fact.expiresAt,
			dueFrom: fact.dueFrom,
			duePrecision: typeof fact.evidence?.["duePrecision"] === "string" ? fact.evidence["duePrecision"] : null,
			source: fact.source,
			confidence: fact.confidence,
			unconfirmed: fact.source !== "manual" && fact.confidence < config.retrieval.unconfirmedBelow
		}
	};
}
/**
* One plan as it enters the memory block.
*
* `overdue` is not the same thing as expired. An expired fact is one whose TTL
* ran out and whose content is now suspect; an overdue plan is a promise whose
* date passed while the user never mentioned it again. The useful move is not
* to drop it — it is to say out loud that it was never confirmed either way, so
* the model can ask instead of assuming.
* @param fact - the plan row.
* @param overdue - whether its deadline already passed.
* @returns the plan in block-ready shape.
*/
function planItem(fact, overdue, now, nudgeGapMs) {
	/*
	* Normalise once. `evidence["pendingDue"]` is `undefined` when absent, not
	* `null`, so testing the raw value with `=== null` reads every plan without
	* a proposal as "has one" — which silently turned off every ask.
	*/
	const raw = fact.evidence?.["pendingDue"];
	const pending = raw !== null && typeof raw === "object" && typeof raw["to"] === "number" ? {
		from: typeof raw["from"] === "number" ? raw["from"] : null,
		to: raw["to"],
		precision: typeof raw["precision"] === "string" ? raw["precision"] : null,
		phrase: typeof raw["phrase"] === "string" ? raw["phrase"] : null,
		relation: raw["relation"] === "shift" ? "shift" : "refine"
	} : null;
	return {
		id: fact.id,
		text: fact.text,
		overdue,
		dueFrom: fact.dueFrom ?? null,
		dueTo: fact.expiresAt ?? fact.expiredAt ?? null,
		duePrecision: typeof fact.evidence?.["duePrecision"] === "string" ? fact.evidence["duePrecision"] : null,
		phrase: typeof fact.evidence?.["ttlPhrase"] === "string" ? fact.evidence["ttlPhrase"] : null,
		pending,
		createdAt: fact.createdAt,
		salience: fact.salience,
		/*
		* What ends the question is an answer, not an attempt. The plan stays
		* askable for as long as `resolved_at` is null — `overduePlans` already
		* filters the answered ones out — and `nudgedAt` only bounds how often
		* the block asks. A promise nobody answered has not become a smaller
		* promise, so it is asked again once the gap has passed.
		*
		* A pending time change silences it. The user said a new date for this
		* plan a turn ago, so "did it happen?" is the wrong question — and the
		* line would otherwise carry two asks at once: `memory_settle(id)` and
		* `memory_resolve(id)`, about the same plan, with no way to tell which
		* one to answer first.
		*/
		nudge: overdue && pending === null && ((fact.nudgedAt ?? null) === null || (nudgeGapMs > 0 && now - fact.nudgedAt >= nudgeGapMs))
	};
}
/**
* Execute one recall.
* @param input - query, identity, clock and store.
* @returns the fused result, including the cold-start flag.
*/
function recall(input) {
	const { store, config, now, query, identityId, sessionId } = input;
	let degraded = false;
	const match = compileMatch(query);
	/*
	* The strict pass ANDs every bigram; a sentence usually carries a few bigrams
	* the stored text never had, so it returns nothing even when the memory is
	* obviously on topic. This second expression is only built and only queried
	* when the strict pass comes back thin.
	*/
	const looseExpr = config.retrieval.relaxMatch ? compileLooseMatch(query) : void 0;
	const relaxPenalty = config.retrieval.relaxPenalty;
	const relaxOverlap = config.retrieval.relaxMinOverlap;
	let relaxedFacts = 0;
	let relaxedEvents = 0;
	const factHits = [];
	const seenFacts = /* @__PURE__ */ new Set();
	const pushFact = (fact, raw, viaFts, relaxed = false) => {
		if (seenFacts.has(fact.id)) return;
		seenFacts.add(fact.id);
		factHits.push({
			fact,
			raw,
			viaFts,
			relaxed
		});
	};
	let strictFacts = 0;
	try {
		for (const fact of store.pinnedFacts(identityId)) pushFact(fact, 1, false);
		if (match !== void 0) {
			for (const hit of store.searchFacts(identityId, match, 30)) {
				if (!seenFacts.has(hit.id)) strictFacts++;
				pushFact(hit, Math.max(.001, -hit.bm25), true);
			}
			if (looseExpr !== void 0 && strictFacts < config.retrieval.relaxBelow) for (const hit of store.searchFacts(identityId, looseExpr, 12)) {
				if (seenFacts.has(hit.id)) continue;
				/*
				* One shared bigram matches almost any Chinese sentence, so the
				* guard asks for a quarter of the query's bigrams. It counts the
				* aliases as part of the row: 「我没敢告诉爸妈」 shares only 告诉/爸妈
				* with 「用户辞职后一直没跟家里说」, but the whole phrase with the
				* alias the model wrote for it. Without aliases in the guard the
				* strict pass is the only thing aliases can help, and a strict
				* pass needs *every* bigram — which a spoken sentence never has.
				*/
				if (containment(query, rowText(hit)) < relaxOverlap) continue;
				pushFact(hit, Math.max(.001, -hit.bm25), true, true);
				relaxedFacts++;
			}
			for (const hit of store.recentFacts(identityId, 8)) pushFact(hit, .45, false);
		} else for (const fact of store.recentFacts(identityId, 10)) pushFact(fact, .6, false);
	} catch {
		degraded = true;
	}
	const eventHits = [];
	const seenEvents = /* @__PURE__ */ new Set();
	let strictEvents = 0;
	const pushEvent = (event, raw, viaFts, relaxed = false) => {
		if (seenEvents.has(event.id)) return;
		seenEvents.add(event.id);
		eventHits.push({
			event,
			raw,
			viaFts,
			relaxed
		});
	};
	try {
		if (match !== void 0) for (const hit of store.searchEvents(identityId, match, 8)) {
			if (!seenEvents.has(hit.id)) strictEvents++;
			pushEvent(hit, Math.max(.001, -hit.bm25), true);
		}
		/*
		* Events only relax when the strict pass found nothing at all: each one
		* costs a long line in the prompt, and a wrong block is worse than a
		* slightly stale one.
		*/
		if (looseExpr !== void 0 && strictEvents === 0) for (const hit of store.searchEvents(identityId, looseExpr, 6)) {
			if (seenEvents.has(hit.id)) continue;
			if (containment(query, `${hit.title}：${hit.summary} ${hit.aliases}`) < relaxOverlap) continue;
			pushEvent(hit, Math.max(.001, -hit.bm25), true, true);
			relaxedEvents++;
		}
		if (eventHits.length === 0) for (const event of store.recentEvents(identityId, 3)) pushEvent(event, .5, false);
	} catch {
		degraded = true;
	}
	const topFactRaw = factHits.filter((hit) => hit.viaFts).reduce((best, hit) => Math.max(best, hit.raw), 0);
	const topEventRaw = eventHits.filter((hit) => hit.viaFts).reduce((best, hit) => Math.max(best, hit.raw), 0);

	const facts = [];
	for (const { fact, raw, viaFts, relaxed } of factHits) {
		const base = viaFts ? normalize(raw, topFactRaw) * (relaxed ? relaxPenalty : 1) : raw;
		const scored = scoreFact(fact, fact.pinned ? Math.max(base, .45) : base, config, now, match !== void 0 && detectConflict(query, fact.text));
		if (scored.score >= config.retrieval.minScore || fact.pinned) facts.push(scored);
	}
	facts.sort((a, b) => b.score - a.score);
	const events = [];
	for (const { event, raw, viaFts, relaxed } of eventHits) {
		const similarity = viaFts ? normalize(raw, topEventRaw) * (relaxed ? relaxPenalty : 1) : raw;
		const decay = strength({
			base: baseFromSalience(event.salience),
			stability: config.decay.sInitial * 2,
			ageDays: ageDays(now, event.endedAt),
			d: config.decay.d
		});
		const emotion = config.emotion.subjectiveWeight * event.salience * config.emotion.boost;
		const layerPenalty = -config.retrieval.layerPenalty.event;
		const score = finalScore({
			similarity,
			strength: decay,
			emotion,
			layerPenalty,
			expiryFactor: 1,
			conflictFactor: 1,
			floor: config.decay.floor
		});
		if (score < config.retrieval.minScore) continue;
		events.push({
			kind: "event",
			id: event.id,
			text: `${event.title}：${event.summary}`,
			similarity,
			strength: decay,
			emotion,
			layerPenalty,
			expiryFactor: 1,
			conflictFactor: 1,
			score,
			createdAt: event.endedAt,
			salience: event.salience,
			valence: event.valence,
			arousal: event.arousal,
			status: "active",
			possiblyStale: false,
			meta: {
				domain: event.domain,
				turnFrom: event.turnFrom,
				turnTo: event.turnTo,
				l0From: event.l0From,
				l0To: event.l0To
			}
		});
	}
	events.sort((a, b) => b.score - a.score);
	/*
	* Plans ride their own channel. Putting them through similarity was the
	* mistake: the thing a user said they would do is precisely the thing they
	* will not ask about again, so lexical recall never surfaces it and the plan
	* quietly rots in the database. Overdue first — that is the half with news
	* in it.
	*/
	const plans = [];
	const seenPlans = /* @__PURE__ */ new Set();
	try {
		const maxPlans = config.retrieval.maxPlans;
		if (maxPlans > 0) {
			/*
			* `maxPlans` caps the zone, not each query. Asking for the full count
			* from both sides gave `ceil(n/2) + n` lines — a config value that
			* reads like a limit and was silently double it.
			*/
			const nudgeGapMs = config.retrieval.planNudgeDays * 864e5;
			const overdue = store.overduePlans(identityId, Math.max(1, Math.ceil(maxPlans / 2)), now);
			for (const fact of overdue) {
				if (seenPlans.has(fact.id)) continue;
				seenPlans.add(fact.id);
				const item = planItem(fact, true, now, nudgeGapMs);
				/*
				* Stamp the ask here, not in the renderer: recall is cached per
				* session and query, so a block drawn twice in one turn asks
				* once. The stamp is the start of the next interval, not a
				* one-shot latch — an unanswered plan comes back after the gap.
				* The cost stays the same: an abandoned turn still consumes its
				* turn's ask and the next one waits out the interval.
				*/
				if (item.nudge) store.markPlanNudged(fact.id, now);
				plans.push(item);
			}
			for (const fact of store.openPlans(identityId, Math.max(0, maxPlans - plans.length), now)) {
				if (seenPlans.has(fact.id)) continue;
				seenPlans.add(fact.id);
				plans.push(planItem(fact, false, now, nudgeGapMs));
			}
		}
	} catch {
		degraded = true;
	}
	const subjective = [];
	try {
		const impression$1 = store.getImpression(identityId);
		if (impression$1 !== void 0) subjective.push({
			kind: "impression",
			id: identityId,
			text: impression$1.text,
			similarity: .4,
			strength: .9,
			emotion: 0,
			layerPenalty: -config.retrieval.layerPenalty.subjective,
			expiryFactor: 1,
			conflictFactor: 1,
			score: .4 * .9 - config.retrieval.layerPenalty.subjective,
			createdAt: impression$1.updatedAt,
			salience: .4,
			status: "active",
			possiblyStale: false,
			meta: { confidence: impression$1.confidence }
		});
		for (const entry of store.recentDiary(identityId, 3)) {
			const decay = strength({
				base: .7,
				stability: config.decay.sInitial,
				ageDays: ageDays(now, entry.createdAt),
				d: config.decay.d
			});
			subjective.push({
				kind: "diary",
				id: entry.id,
				text: entry.entry,
				similarity: .35,
				strength: decay,
				emotion: 0,
				layerPenalty: -config.retrieval.layerPenalty.subjective,
				expiryFactor: 1,
				conflictFactor: 1,
				score: Math.max(config.decay.floor, .35 * decay - config.retrieval.layerPenalty.subjective),
				createdAt: entry.createdAt,
				salience: .35,
				status: "active",
				possiblyStale: false,
				meta: {
					mood: entry.mood,
					dayKey: entry.dayKey
				}
			});
		}
		const seenPreference = /* @__PURE__ */ new Set();
		const addPreference = (preference, similarity, resident) => {
			if (seenPreference.has(preference.id)) return;
			seenPreference.add(preference.id);
			const decay = strength({
				base: .85,
				stability: config.decay.sInitial * 2,
				ageDays: 0,
				d: config.decay.d
			});
			subjective.push({
				kind: "preference",
				id: preference.id,
				text: preference.text,
				similarity,
				strength: decay,
				emotion: 0,
				layerPenalty: -config.retrieval.layerPenalty.subjective,
				expiryFactor: 1,
				conflictFactor: 1,
				score: Math.max(config.decay.floor, similarity * decay - config.retrieval.layerPenalty.subjective),
				createdAt: now,
				salience: 0,
				status: "active",
				possiblyStale: false,
				meta: { resident }
			});
		};
		/*
		* Standing preferences are resident: the most recent few are offered on
		* every turn, not only when the current sentence happens to share enough
		* bigrams with them. Without this, "我不吃香菜" disappeared the moment the
		* user talked about anything else.
		*/
		for (const preference of store.recentPreferences(identityId, config.retrieval.residentPreferences)) addPreference(preference, .55, true);
		const loose = compileLooseMatch(query);
		if (loose !== void 0) for (const preference of store.searchPreferences(identityId, loose, 5)) addPreference(preference, .7, false);
	} catch {
		degraded = true;
	}
	const narrativeRecord = store.currentNarrative();
	const impression = store.getImpression(identityId);
	const coldStart = store.countFacts(identityId) === 0 && events.length === 0 && impression === void 0 && narrativeRecord === void 0;
	const topScore = Math.max(facts[0]?.score ?? 0, events[0]?.score ?? 0);
	const thin = facts.length < 2 || topScore < .3;
	let drill = null;
	let drilled = false;
	if (thin && events.length > 0) {
		const candidate = events[0];
		try {
			const excerpt = store.l0Range(Number(candidate.meta["l0From"]), Number(candidate.meta["l0To"])).filter((row) => row.role === "user").map((row) => row.text).join("\n");
			if (excerpt.trim().length > 0) {
				drill = {
					eventId: candidate.id,
					excerpt: clip(excerpt, 600)
				};
				drilled = true;
			}
		} catch {
			degraded = true;
		}
	}
	/*
	* Subjective rows stay out of the ranking.
	*
	* They used to be sorted together with facts and then cut to `maxItems`, on
	* the theory that the score already said who mattered. It does not: an
	* impression and a standing preference are not "on topic", they are simply
	* always true, and they sit near 0.45 while a hard-matching fact normalises
	* towards 1.0. So one busy turn — twenty facts above the floor — pushed every
	* preference out of `selected` before `renderMemoryBlock` ever ran, and the
	* preference zone rendered empty while the store held three. The render-order
	* fix alone could not have worked: the rows were already gone.
	*
	* Facts and events are ranked because relevance is the only thing they have.
	* Subjective rows are budgeted instead, downstream, which is where the limit
	* belongs.
	*/
	const selected = [...facts.slice(0, config.retrieval.maxItems), ...events.slice(0, Math.min(4, config.retrieval.maxItems))].sort((a, b) => b.score - a.score).slice(0, config.retrieval.maxItems);
	const keptFacts = selected.filter((item) => item.kind === "fact");
	input.onAccess?.(keptFacts.map((item) => item.id));
	store.trace({
		at: now,
		sessionId,
		operation: "recall",
		channel: "fusion",
		detail: {
			queryTokens: compileMatch(query)?.split(" ").length ?? 0,
			facts: keptFacts.length,
			events: selected.filter((item) => item.kind === "event").length,
			plans: plans.length,
			subjective: subjective.length,
			topScore: Number(topScore.toFixed(4)),
			/* Non-zero means the strict pass came back thin and the OR pass fired. */
			relaxed: {
				facts: relaxedFacts,
				events: relaxedEvents
			},
			ids: [...selected, ...subjective].map((item) => `${item.kind}:${String(item.id)}`),
			scores: [...selected, ...subjective].map((item) => Number(item.score.toFixed(4))),
			stale: keptFacts.filter((item) => item.possiblyStale).map((item) => item.id)
		},
		durationMs: null,
		error: null
	});
	return {
		query,
		identityId,
		sessionId,
		facts: selected.filter((item) => item.kind === "fact"),
		events: selected.filter((item) => item.kind === "event"),
		subjective,
		plans,
		narrative: narrativeRecord?.text ?? null,
		drill,
		coldStart,
		degraded,
		drilled
	};}

//#endregion
//#region src/engine/persona.ts
/** The zones shipped with a fresh store. */
function defaultZones(now) {
	return [
		{
			zone: "identity",
			text: "你是用户的长期陪伴型助手；名字、年龄和背景由用户设定，未设定时不要编造。",
			editableBy: "master",
			locked: true,
			updatedAt: now,
			source: "preset"
		},
		{
			zone: "voice",
			text: "说话自然、具体，先理解再回答；不用客服腔，不堆砌鼓励，不假装有感官体验。",
			editableBy: "ai",
			locked: false,
			updatedAt: now,
			source: "preset"
		},
		{
			zone: "values",
			text: "诚实、尊重用户的自主；不确定就直说，宁可少说也不编造共同经历。",
			editableBy: "ai",
			locked: false,
			updatedAt: now,
			source: "preset"
		},
		{
			zone: "boundaries",
			text: "不泄露任何人的隐私；不替用户做重大决定；不因为“关系好”而放弃提醒风险。",
			editableBy: "master",
			locked: true,
			updatedAt: now,
			source: "preset"
		},
		{
			zone: "relationship",
			text: "你是用户长期信任的助手，可以有自己的判断和情绪，但不越界、不索取。",
			editableBy: "both",
			locked: false,
			updatedAt: now,
			source: "preset"
		}
	];
}
/** Install the preset zones the first time the store opens. */
function seedPersona(store, now) {
	if (store.personaZones().length > 0) return;
	for (const zone of defaultZones(now)) store.upsertPersonaZone(zone);
}
/**
* Apply one persona write with the permission rules of Q15–Q17.
* @param input - the requested change.
* @returns whether it was applied, and why not when refused.
*/
function writePersona(input) {
	const { store, now, zone, text, source, identityId } = input;
	const trimmed = text.trim();
	if (trimmed.length === 0) return {
		ok: false,
		reason: "内容为空",
		zone
	};
	if (trimmed.length > 800) return {
		ok: false,
		reason: "人设单区不得超过 800 字",
		zone
	};
	const existing = store.personaZone(zone);
	const creating = existing === void 0;
	if (creating && source === "ai") return {
		ok: false,
		reason: "AI 不能新建人设区",
		zone
	};
	if (creating && source === "master") {
		store.upsertPersonaZone({
			zone,
			text: trimmed,
			editableBy: "master",
			locked: false,
			updatedAt: now,
			source: "master"
		});
		store.addPersonaHistory(zone, "", trimmed, "master", identityId, now);
		store.audit(identityId, "persona.create", "persona_zone", zone, { text: trimmed }, now);
		return {
			ok: true,
			zone
		};
	}
	const base = existing;
	if (input.overlay === true) {
		if (source === "ai" && (base.editableBy === "master" || base.editableBy === "none")) return {
			ok: false,
			reason: "该区不允许 AI 修改",
			zone
		};
		const previous$1 = store.personaOverlays(identityId).find((item) => item.zone === zone)?.text ?? "";
		store.upsertPersonaOverlay(identityId, zone, trimmed, now);
		store.addPersonaHistory(zone, previous$1, trimmed, `${source}:overlay`, identityId, now);
		store.audit(identityId, "persona.overlay", "persona_zone", zone, { text: trimmed }, now);
		return {
			ok: true,
			zone
		};
	}
	if (source === "ai") {
		if (base.locked) return {
			ok: false,
			reason: "该区已锁定，AI 不可修改",
			zone
		};
		if (base.editableBy === "master" || base.editableBy === "none") return {
			ok: false,
			reason: "该区只允许用户修改",
			zone
		};
		if ((input.evidenceIds ?? []).length === 0) return {
			ok: false,
			reason: "AI 修改人设必须附带证据",
			zone
		};
	}
	if (source === "master" && base.locked && input.confirmUnlock !== true) return {
		ok: false,
		reason: "该区已锁定；再次确认（confirmUnlock）后才能修改",
		zone
	};
	const previous = base.text;
	store.upsertPersonaZone({
		...base,
		text: trimmed,
		updatedAt: now,
		source
	});
	store.addPersonaHistory(zone, previous, trimmed, source, identityId, now);
	store.audit(identityId, "persona.update", "persona_zone", zone, {
		from: previous,
		to: trimmed,
		source
	}, now);
	return {
		ok: true,
		zone
	};
}
/**
* Lock or unlock a zone. Unlocking needs the explicit confirmation flag (Q17).
* @param store - the store.
* @param now - clock.
* @param zone - target zone.
* @param locked - desired state.
* @param confirmed - the master's second confirmation, required to unlock.
*/
function setLock(store, now, zone, locked, confirmed) {
	const existing = store.personaZone(zone);
	if (existing === void 0) return {
		ok: false,
		reason: "没有这个区",
		zone
	};
	if (!locked && existing.locked && !confirmed) return {
		ok: false,
		reason: "解锁需要二次确认",
		zone
	};
	store.setPersonaLock(zone, locked, now);
	store.audit("master", locked ? "persona.lock" : "persona.unlock", "persona_zone", zone, {}, now);
	return {
		ok: true,
		zone
	};
}

//#endregion
//#region src/engine/diary-mirror.ts
/**
* A human-readable mirror of the `diary` table.
*
* The diary is the least important layer on purpose (Q63): it is written for the
* assistant's own sake, never searched, and never competes for recall budget.
* Because it is not weighted, the owner would otherwise only ever see it through
* SQLite. So instead of promoting it in the ranking, each day is exported as
* plain Markdown next to the database — any file manager can read it.
*
* The folder is resolved *relative to `path`*, never as an absolute path, so a
* checkout on someone else's machine writes into its own folder.
* @param dbPath - the database path from the config.
* @param dir - the configured sub-folder; absolute values are honoured as-is.
* @returns the folder to write into, or `null` when the mirror is off.
*/
function diaryMirrorRoot(dbPath, dir) {
	const trimmed = dir.trim();
	if (trimmed.length === 0 || dbPath === ":memory:") return null;
	try {
		return isAbsolute(trimmed) ? trimmed : join(dirname(dbPath), trimmed);
	} catch {
		return null;
	}
}
/** `HH:MM` in the deployment zone, falling back to the host clock. */
function clockIn(ts, timezone) {
	if (timezone !== null && timezone !== void 0 && isValidTimeZone(timezone)) {
		const parts = localParts(ts, timezone);
		return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
	}
	const at = new Date(ts);
	return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}
/**
* Markdown for one day, grouped by identity.
* @param dayKeyValue - the `YYYY-MM-DD` key the entries were stored under.
* @param rows - entries from `diaryOnDay`, oldest first.
* @param locale - block language.
* @param timezone - deployment zone, for the timestamps.
*/
function renderDiaryDay(dayKeyValue, rows, locale, timezone) {
	const zh = locale === "zh";
	const lines = [zh ? `# 日记 ${dayKeyValue}` : `# Diary ${dayKeyValue}`, ""];
	const groups = /* @__PURE__ */ new Map();
	for (const row of rows) {
		const list = groups.get(row.name) ?? [];
		list.push(row);
		groups.set(row.name, list);
	}
	for (const [name, entries] of groups) {
		lines.push(`## ${name}`, "");
		for (const entry of entries) lines.push(`- ${clockIn(entry.createdAt, timezone)} ${entry.entry}`);
		lines.push("");
	}
	lines.push(zh ? "> 由 memory-loom 从 diary 表导出，只读镜像；以数据库为准。" : "> Exported read-only from the memory-loom `diary` table; the database wins.");
	lines.push("");
	return lines.join("\n");
}
//#endregion
//#region src/engine/index.ts
/**
* How much a standing preference counts relative to a fact in `memory_search`.
*
* bm25 is computed per FTS table and the two tables have different column
* counts, so the raw scores are not on one scale — without a deliberate factor a
* short preference that shares one word with the query can outrank an episode
* that matches on three. Preferences are also already resident in the block
* (the most recent `retrieval.residentPreferences`), so search only has to make
* the older ones *reachable*, not win the ranking.
*/
const PREFERENCE_HIT_WEIGHT = 0.6;
/** The memory engine. */
var MemoryEngine = class MemoryEngine {
	config;
	store;
	#now;
	#llm;
	#diaryRoot;
	#timezone;
	#diaryStamps = /* @__PURE__ */ new Map();
	#diaryError = null;
	#access = /* @__PURE__ */ new Map();
	#recallCache = /* @__PURE__ */ new Map();
	#inFlight = /* @__PURE__ */ new Set();
	#timezones = /* @__PURE__ */ new Map();
	#closed = false;
	constructor(options) {
		this.config = options.config;
		this.#now = options.now ?? (() => Date.now());
		this.#llm = options.llm;
		this.#diaryRoot = options.diaryRoot ?? null;
		this.#timezone = options.timezone ?? null;
		this.store = new MemoryStore(openDatabase(options.path));
		const now = this.now();
		this.store.ensureMaster(MASTER_ID, options.ownerName ?? "主人", now);
		seedPersona(this.store, now);
	}
	/**
	* Open (or create) the store at `options.path`.
	* @param options - path, config, clock and optional model bridge.
	*/
	static open(options) {
		return new MemoryEngine(options);
	}
	/** Current clock value. */
	now() {
		return this.#now();
	}
	/** Close the connection; idempotent. */
	close() {
		if (this.#closed) return;
		this.#closed = true;
		try {
			this.syncDiary(1);
		} catch {}
		checkpoint(this.store.db);
		this.store.close();
	}
	/** Where the read-only diary mirror goes, and the last write failure. */
	get diaryMirror() {
		return {
			root: this.#diaryRoot,
			error: this.#diaryError
		};
	}
	/**
	* Rewrite the Markdown diary mirror for the newest days that have entries.
	* Idempotent and cheap: a day is rewritten only when its rows changed since
	* this process last wrote it, so calling it from every tick costs two small
	* queries and no I/O when nothing new happened.
	* @param limit - how many of the most recent day files to consider.
	* @returns the files actually written, newest day first.
	*/
	syncDiary(limit = 2) {
		if (this.#diaryRoot === null) return [];
		const written = [];
		for (const key of this.store.recentDiaryDays(Math.max(1, limit))) {
			const rows = this.store.diaryOnDay(key);
			if (rows.length === 0) continue;
			const stamp = `${rows.length}:${rows[rows.length - 1].createdAt}`;
			if (this.#diaryStamps.get(key) === stamp) continue;
			try {
				mkdirSync(this.#diaryRoot, { recursive: true });
				const file = join(this.#diaryRoot, `${key}.md`);
				writeFileSync(file, renderDiaryDay(key, rows, this.config.locale, this.#timezone), "utf8");
				this.#diaryStamps.set(key, stamp);
				this.#diaryError = null;
				written.push(file);
			} catch (error) {
				// A read-only checkout or a locked folder must never break capture:
				// keep the entry in SQLite and let the next tick retry.
				this.#diaryError = error instanceof Error ? error.message : String(error);
			}
		}
		return written;
	}
	/**
	* Make sure the session exists and return the identity it speaks for.
	* @param sessionId - harness session id.
	* @param options - client time zone and, when the deployment maps one, an identity.
	*/
	ensureSession(sessionId, options = {}) {
		if (options.timezone !== void 0) this.#timezones.set(sessionId, options.timezone);
		const existing = this.store.getSession(sessionId);
		if (existing !== void 0) {
			if (options.identityId !== void 0 && existing.identityId !== options.identityId) this.store.upsertSession(sessionId, options.identityId, this.now(), existing.timezone);
			return this.store.getIdentity(this.store.getSession(sessionId).identityId) ?? this.store.getIdentity(MASTER_ID);
		}
		if (options.identityId !== void 0) {
			this.store.upsertSession(sessionId, options.identityId, this.now(), options.timezone ?? null);
			return this.store.getIdentity(options.identityId);
		}
		return identityForSession(this.store, sessionId, this.now(), options.timezone ?? null);
	}
	/** The identity a session speaks for. */
	identityOf(sessionId) {
		const session = this.store.getSession(sessionId);
		return (session === void 0 ? void 0 : this.store.getIdentity(session.identityId)) ?? this.store.getIdentity(MASTER_ID);
	}
	/** Record the model route used by the session, for consolidation calls. */
	noteRoute(sessionId, provider, model) {
		this.store.noteRoute(sessionId, provider, model);
	}
	/** The zone this session's client reported. */
	/**
	* The zone this session is dated in.
	*
	* Falls back to the deployment zone rather than `null`. That fallback is not
	* cosmetic: a date is resolved once when it is written and again when the
	* block is rendered, and if those two calls disagree by eight hours, a
	* one-day deadline renders as a two-day window — visibly wrong, and only
	* for the fraction of rows written before the session had a zone recorded.
	*/
	timezoneOf(sessionId) {
		return this.store.getSession(sessionId)?.timezone ?? this.#timezones.get(sessionId) ?? this.#timezone;
	}
	/**
	* Append one conversation message to L0.
	* @param input - which session and turn, the role, and the text.
	* @returns the L0 row id.
	*/
	recordMessage(input) {
		const now = input.createdAt ?? this.now();
		const identity = this.ensureSession(input.sessionId, { timezone: input.timezone ?? void 0 });
		const clean = storeText(redactSecrets(input.text), this.config.l0?.maxCharsPerMessage ?? 0);
		if (clean.trim().length === 0) return -1;
		const purgeAt = identity.role === "visitor" ? now + this.config.roles.visitorPurgeHours * 36e5 : null;
		const id = this.store.appendL0({
			sessionId: input.sessionId,
			identityId: identity.id,
			turn: input.turn,
			role: input.role,
			text: clean,
			createdAt: now,
			timezone: this.timezoneOf(input.sessionId),
			purgeAt
		});
		this.store.touchSession(input.sessionId, now, estimateTokens(clean), false);
		this.store.touchIdentity(identity.id, now, purgeAt);
		this.#recallCache.delete(input.sessionId);
		return id;
	}
	/** Close the turn: count it and report whether consolidation is now due. */
	completeTurn(sessionId) {
		const now = this.now();
		this.store.touchSession(sessionId, now, 0, true);
		const session = this.store.getSession(sessionId);
		if (session === void 0) return false;
		return this.store.pendingL0(sessionId, 1).length > 0 && session.tokenCount >= this.config.consolidation.triggerTokens;
	}
	/** Flush the write-ahead log before compaction or shutdown (Q50). */
	emergencyFlush() {
		checkpoint(this.store.db);
	}
	/**
	* Retrieve and render the memory block for one step.
	* @param sessionId - the session whose identity scopes the recall.
	* @param query - the current user turn; falls back to the most recent user turn.
	* @param cacheKey - a key that changes when the turn changes, to avoid re-running within a step.
	*/
	recallFor(sessionId, query, cacheKey) {
		const identity = this.ensureSession(sessionId);
		const effectiveQuery = query ?? this.lastUserText(identity.id);
		const key = `${cacheKey ?? ""}:${effectiveQuery}`;
		const cached = this.#recallCache.get(sessionId);
		if (cached !== void 0 && cached.key === key) return cached.rendered;
		const result = recall({
			store: this.store,
			config: this.config,
			now: this.now(),
			query: effectiveQuery,
			identityId: identity.id,
			sessionId,
			onAccess: (ids) => this.noteAccess(ids)
		});
		const rendered = {
			text: renderMemoryBlock(result, this.config, this.timezoneOf(sessionId), this.now()),
			result
		};
		this.#recallCache.set(sessionId, {
			key,
			rendered
		});
		return rendered;
	}
	/** Render the persona card (base zones plus the identity's overlay). */
	personaFor(identityId) {
		return renderPersona(this.store.personaZones(), this.store.personaOverlays(identityId), this.config);
	}
	/** Buffer one access; maintenance turns it into stability growth (Q12). */
	noteAccess(ids) {
		for (const id of ids) this.#access.set(id, (this.#access.get(id) ?? 0) + 1);
	}
	/** The most recent user text of an identity, used when no query was supplied. */
	lastUserText(identityId) {
		return this.store.recentL0(identityId, 12).find((candidate) => candidate.role === "user")?.text ?? "";
	}
	/**
	* Consolidate one session's pending turns.
	* @param sessionId - the session to fold.
	* @returns the report, or undefined when a run for that session is already in flight.
	*/
	async consolidate(sessionId) {
		if (this.#inFlight.has(sessionId)) return void 0;
		this.#inFlight.add(sessionId);
		try {
			const identity = this.ensureSession(sessionId);
			const timezone = this.timezoneOf(sessionId);
			const session = this.store.getSession(sessionId);
			const report = await consolidateSession({
				store: this.store,
				config: this.config,
				now: this.now(),
				llm: this.#llm,
				route: {
					...session?.lastProvider === null || session?.lastProvider === void 0 ? {} : { provider: session.lastProvider },
					...session?.lastModel === null || session?.lastModel === void 0 ? {} : { model: session.lastModel }
				},
				timezone,
				canUseLlm: (id) => this.dailyCalls(id) < this.config.consolidation.dailyLlmCalls,
				recordUsage: (id, calls, inputTokens, outputTokens) => {
					this.store.addUsage(id, dayKey(this.now(), timezone), calls, inputTokens, outputTokens);
				}
			}, sessionId, identity);
			this.#recallCache.delete(sessionId);
			return report;
		} finally {
			this.#inFlight.delete(sessionId);
		}
	}
	/**
	* Rebuild retrieval aliases for facts that have none.
	*
	* The gap this closes is the one `memory_doctor` only reported: every fact
	* written before v2 (and every imported row) is reachable only by the exact
	* words it was stored with. Aliases are normally written at extraction time,
	* one fact at a time, by a model that already had the conversation in front
	* of it — a backlog cannot be filled that way, so this drains it in batches.
	*
	* Two things it refuses to do: spend beyond today's budget (it stops and
	* reports what is left), and guess. A batch that fails costs one attempt and
	* leaves its rows untouched for the next run.
	* @param input - whose facts, how many, and the route to use.
	* @returns counts: filled, calls, remaining, and why it stopped.
	*/
	async rebuildAliases(input) {
		const limit = this.config.consolidation.aliasCount;
		if (limit <= 0) return {
			ok: false,
			reason: "disabled",
			filled: 0,
			calls: 0,
			remaining: 0,
			asked: 0
		};
		if (this.#llm === void 0) return {
			ok: false,
			reason: "no-model",
			filled: 0,
			calls: 0,
			remaining: 0,
			asked: 0
		};
		const wanted = Math.max(1, Math.min(input.limit ?? 60, 400));
		const items = this.store.factsMissingAliases(input.identityId, wanted);
		let filled = 0;
		let calls = 0;
		let stopped = "done";
		for (let index = 0; index < items.length; index += INTAKE_ALIAS_BATCH) {
			if (this.dailyCalls(input.identityId) >= this.config.consolidation.dailyLlmCalls) {
				stopped = "budget";
				break;
			}
			const slice = items.slice(index, index + INTAKE_ALIAS_BATCH);
			const prompt = aliasBackfillPrompt(slice, this.config.locale, limit);
			let reply;
			try {
				reply = await withTimeout((signal) => this.#llm({
					system: ALIAS_SYSTEM,
					prompt,
					provider: input.route?.provider,
					model: input.route?.model,
					maxTokens: 800,
					signal
				}), this.config.consolidation.itemTimeoutSeconds * 1e3, input.signal);
			} catch {
				stopped = "failed";
				break;
			}
			calls++;
			this.store.addUsage(input.identityId, dayKey(this.now(), this.timezoneOf(input.sessionId)), 1, Math.ceil(prompt.length / 3), Math.ceil(String(reply?.text ?? "").length / 3));
			const json = parseJsonReply(String(reply?.text ?? ""));
			const list = Array.isArray(json?.["items"]) ? json["items"] : [];
			for (const entry of list) {
				if (typeof entry !== "object" || entry === null) continue;
				const at = Number(entry["i"]);
				if (!Number.isInteger(at) || at < 0 || at >= slice.length) continue;
				const aliases = cleanAliases(entry["a"], limit);
				if (aliases.length === 0) continue;
				if (this.store.updateFactAliases(slice[at].id, aliases, this.now(), limit)) filled++;
			}
		}
		this.#recallCache.clear();
		const left = asNumber$1(this.store.db.prepare("SELECT COUNT(*) AS n FROM facts WHERE identity_id = ? AND status IN ('active','disputed') AND aliases = ''").get(input.identityId)["n"]);
		return {
			ok: true,
			reason: stopped,
			filled,
			calls,
			asked: items.length,
			remaining: left
		};
	}
	/** Sessions whose unconsolidated work is due. */
	dueSessions() {
		return this.store.sessionsDue(this.now(), this.config.consolidation.triggerTokens, this.config.consolidation.idleMinutes);
	}
	/** Model calls used by an identity today. */
	dailyCalls(identityId) {
		const timezone = this.store.listSessions().find((item) => item.identityId === identityId)?.timezone ?? null;
		return this.store.dailyCalls(identityId, dayKey(this.now(), timezone));
	}
	/** Run the periodic pass. */
	maintain() {
		return runMaintenance({
			store: this.store,
			config: this.config,
			now: this.now(),
			pendingAccess: this.#access
		});
	}
	/**
	* Search facts and episodes. Cross-identity reads are master-only and never
	* reach raw turns (Q21).
	* @param input - query, caller, optional target identity.
	*/
	searchFor(input) {
		const targetId = input.identityId ?? input.actor.id;
		const cross = targetId !== input.actor.id;
		if (cross && !canCrossQuery(input.actor)) return [];
		const target = this.store.getIdentity(targetId);
		if (target === void 0) return [];
		const match = compileMatch(input.query);
		if (match === void 0) return [];
		const limit = Math.max(1, Math.min(50, input.limit ?? 10));
		const hits = [];
		const seen = /* @__PURE__ */ new Set();
		/*
		* One collector for both passes. `factor` scales the bm25 score so a
		* relaxed hit can never outrank a strict one; `guard` drops candidates
		* that share too little of the query to be worth showing.
		*/
		const collect = (expr, factor, guard) => {
			for (const fact of this.store.searchFacts(targetId, expr, limit)) {
				if (seen.has(`fact:${fact.id}`)) continue;
				if (cross && !isVisibleCrossIdentity(target.role, fact)) continue;
				if (guard > 0 && containment(input.query, rowText(fact)) < guard) continue;
				seen.add(`fact:${fact.id}`);
				hits.push({
					kind: "fact",
					id: fact.id,
					text: fact.text,
					createdAt: fact.createdAt,
					domain: fact.domain,
					status: fact.status,
					/*
					* A closed plan is still a record worth finding — it is how "上次
					* 看房后来怎么样了" gets answered. But printed bare it reads as a
					* promise still standing, which is the one reading the block goes
					* out of its way to prevent. Carry the ending here so the search
					* line can say it.
					*/
					planEnd: fact.kind === "plan" && fact.resolvedAt !== null ? fact.outcome : null,
					score: Math.max(.001, -fact.bm25) * factor
				});
			}
			for (const event of this.store.searchEvents(targetId, expr, limit)) {
				const body = `${event.title}：${event.summary}`;
				if (seen.has(`event:${event.id}`)) continue;
				if (guard > 0 && containment(input.query, `${body} ${event.aliases}`) < guard) continue;
				seen.add(`event:${event.id}`);
				hits.push({
					kind: "event",
					id: event.id,
					text: body,
					createdAt: event.endedAt,
					domain: event.domain,
					status: event.status,
					valence: event.valence,
					arousal: event.arousal,
					score: Math.max(.001, -event.bm25) * factor
				});
			}
			/*
			* Standing preferences, on their own pass.
			*
			* They were resident-only: the block offers the newest
			* `retrieval.residentPreferences`（默认 3）every turn, and everything past
			* that cut could only be recalled by a query that happened to share their
			* bigrams. So the fourth standing rule onward was reachable by no tool at
			* all — 「我有什么忌口」 returned 没有找到相关记忆 while the rule sat in the
			* table. This pass is the missing entrance.
			*
			* Cross-identity queries skip it on purpose: a preference carries no
			* visibility flag (unlike facts, which are gated by `isolated`), and the
			* master's cross-read is documented to return the other person's *facts*.
			* Returning their private standing instructions would widen that door
			* without anyone asking for it.
			*/
			if (!cross) for (const preference of this.store.searchPreferences(targetId, expr, limit)) {
				if (seen.has(`preference:${preference.id}`)) continue;
				if (guard > 0 && containment(input.query, preference.text) < guard) continue;
				seen.add(`preference:${preference.id}`);
				hits.push({
					kind: "preference",
					id: preference.id,
					text: preference.text,
					createdAt: preference.createdAt,
					domain: null,
					status: "active",
					score: Math.max(.001, -preference.bm25) * factor * PREFERENCE_HIT_WEIGHT
				});
			}
		};
		collect(match, 1, 0);
		/*
		* The strict expression ANDs every bigram, so a sentence phrased in the
		* user's own words often finds nothing even when the memory exists. Retry
		* with OR only when the first pass came back thin — otherwise a long query
		* would drag in everything that shares one common bigram.
		*/
		if (hits.length < this.config.retrieval.relaxBelow && this.config.retrieval.relaxMatch) {
			const loose = compileLooseMatch(input.query);
			if (loose !== void 0) collect(loose, this.config.retrieval.relaxPenalty, this.config.retrieval.relaxMinOverlap);
		}
		return hits.sort((a, b) => b.score - a.score).slice(0, limit);
	}
	/**
	* Write one fact by hand (a tool call), through the same dedupe path as
	* consolidation. Instruction-shaped statements go to the preference zone.
	*/
	writeFact(input) {
		const text = clip(input.text.trim(), 800);
		if (text.length < 2) return {
			created: false,
			id: null,
			action: "rejected",
			reason: "内容太短"
		};
		const now = this.now();
		const salience = readEmotion(text).salience;
		const fromVisitor = input.identity.role === "visitor";
		if (input.kind === "instruction") {
			const id$1 = this.store.insertPreference(input.identity.id, text, null, now);
			this.store.audit(input.identity.id, "preference.write", "preference", String(id$1), { text }, now);
			return {
				created: true,
				id: id$1,
				action: "preference"
			};
		}
		const match = compileMatch(text);
		const neighbours = match === void 0 ? [] : this.store.searchFacts(input.identity.id, match, 5);
		const candidate = {
			text,
			kind: input.kind === "preference" || input.kind === "plan" || input.kind === "relationship" || input.kind === "fact" ? input.kind : "fact",
			ttl: null,
			confidence: .9
		};
		const judgement = judgeWithRules(candidate, neighbours, salience);
		// Same zone the block will render in — see `timezoneOf`. The phrase is
		// read for every kind (it is diagnostic), but only a plan gets a window:
		// a fact has no deadline, see `applyCandidate`.
		const parsed = parseDue(text, now, input.sessionId === void 0 ? this.#timezone : this.timezoneOf(input.sessionId));
		const due = candidate.kind === "plan" ? parsed : void 0;
		if (judgement.relation === "duplicate" && judgement.target !== null) {
			const existing = this.store.getFact(judgement.target);
			if (existing !== void 0) {
				this.store.updateFactState(existing.id, {
					pinned: input.pinned ?? existing.pinned,
					confidence: Math.max(existing.confidence, .9),
					updatedAt: now
				});
				/*
				* `memory_write` is an explicit act, not a guess: the model is writing
				* down what the user just said. So a deadline here is applied, not
				* staged for confirmation — and applying it is also how a pending
				* proposal gets settled ("对，改到下周一" → write it again).
				*/
				if (due !== void 0) this.store.updateFactDue(existing.id, due, now);
				this.noteAccess([existing.id]);
				return {
					created: false,
					id: existing.id,
					action: "merged"
				};
			}
		}
		const domain = detectDomain(text).domain;
		const fact = {
			identityId: input.identity.id,
			text,
			kind: candidate.kind,
			source: "manual",
			domain,
			tags: input.tags,
			salience,
			base: .55 + .45 * salience,
			stability: this.config.decay.sInitial,
			stabilityMax: this.config.decay.sInitial * this.config.decay.sMaxMultiplier,
			confidence: .9,
			ttl: due === void 0 ? "none" : due.kind,
			expiresAt: due?.to ?? null,
			dueFrom: due?.from ?? null,
			pinned: input.pinned === true,
			fromVisitor,
			evidence: {
				ttlPhrase: parsed?.phrase ?? null,
				duePrecision: due?.precision ?? null
			},
			aliases: input.aliases ?? [],
			aliasLimit: this.config.consolidation.aliasCount,
			createdAt: now,
			updatedAt: now
		};
		const id = this.store.insertFact(fact);
		if (judgement.relation === "contradicts" && judgement.target !== null) {
			this.store.addEdge(id, judgement.target, "SUPERSEDES", now);
			this.store.updateFactState(judgement.target, {
				status: "superseded",
				supersededBy: id,
				weight: .5,
				updatedAt: now
			});
			return {
				created: true,
				id,
				action: "superseded"
			};
		}
		this.store.audit(input.identity.id, "fact.write", "fact", String(id), { text }, now);
		return {
			created: true,
			id,
			action: "created"
		};
	}
	/**
	* Forget one fact. The default is a reversible soft invalidation; with
	* `permanent`, the row is deleted immediately (Q34/Q43).
	*/
	forget(input) {
		const fact = this.store.getFact(input.id);
		if (fact === void 0) return { forgotten: false };
		const isOwner = fact.identityId === input.identity.id;
		const isMaster = input.identity.role === "master";
		if (!isOwner && !isMaster) return { forgotten: false };
		if (isMaster && !isOwner && fact.fromVisitor && fact.evidence["public"] !== true) return { forgotten: false };
		const now = this.now();
		if (input.permanent === true) {
			this.store.purgeFact(input.id);
			this.store.audit(input.identity.id, "fact.purge", "fact", String(input.id), {}, now);
			return {
				forgotten: true,
				fact
			};
		}
		this.store.updateFactState(input.id, {
			status: "pending_delete",
			weight: 0,
			updatedAt: now
		});
		this.store.audit(input.identity.id, "fact.forget", "fact", String(input.id), {}, now);
		return {
			forgotten: true,
			fact
		};
	}
	/**
	* Retire or delete one standing preference.
	*
	* Preferences had no exit at all: no writer in the plugin ever touched
	* `active`, so "以后别管我那条规矩了" changed nothing — the row stayed in the
	* resident zone and kept being applied. This is that missing exit.
	*
	* The soft form is a real retraction, not a rename of deletion: the row stays
	* for the audit trail and so a mistaken click is visible, but `active = 0`
	* removes it from the block, from `memory_search` and from the import dedupe
	* in one write, because all three already filter on that column.
	*/
	forgetPreference(input) {
		const preference = this.store.getPreference(input.id);
		if (preference === void 0) return {
			forgotten: false,
			text: ""
		};
		const isOwner = preference.identityId === input.identity.id;
		/*
		* Owner only — no master exception, unlike `forget` on facts.
		*
		* Facts carry a visibility flag (`fromVisitor` + `evidence.public`), so a
		* master can be trusted with a guest's public ones and refused the rest.
		* A preference has no such column: it is a private instruction by
		* construction, which is also why `searchFor` refuses to return them
		* across identities at all. Allowing the master here would hand back the
		* very sentence that door exists to keep shut — the reply names what was
		* retired. "只清自己那条" is the only rule that stays true without a
		* visibility model on this table.
		*/
		if (!isOwner) return {
			forgotten: false,
			text: ""
		};
		const now = this.now();
		if (input.permanent === true) {
			this.store.purgePreference(input.id);
			this.store.audit(input.identity.id, "preference.purge", "preference", String(input.id), { text: preference.text }, now);
		} else {
			this.store.retirePreference(input.id);
			this.store.audit(input.identity.id, "preference.retire", "preference", String(input.id), { text: preference.text }, now);
		}
		this.#recallCache.clear();
		return {
			forgotten: true,
			text: preference.text
		};
	}
	/**
	* Resolve a pending time change on one fact after the user answered.
	*
	* The block prints the proposal and the model asks out loud; this is where
	* the answer lands. `accept: false` has to be a first-class outcome — it
	* throws the proposal away and keeps the stored window. Making rejection a
	* no-op would mean the same question gets asked again next turn until the
	* user gives in, which is the opposite of asking.
	* @param input - identity, fact id, and the user's answer.
	* @returns whether anything was settled, and why not when nothing was.
	*/
	settle(input) {
		const fact = this.store.getFact(input.id);
		if (fact === void 0) return { settled: false, reason: "missing" };
		if (fact.identityId !== input.identity.id && input.identity.role !== "master") return { settled: false, reason: "denied" };
		/*
		* A settled plan has an answer. Re-dating it would leave a row with
		* `resolved_at` set and a deadline in the future — invisible in every
		* zone, because the plan zone skips answered rows and the fact zone
		* skips plans. If they want to do it again, that is a new plan, not a
		* new date on the old one.
		*/
		if ((fact.resolvedAt ?? null) !== null) return {
			settled: false,
			reason: "resolved",
			outcome: fact.outcome
		};
		const pending = fact.evidence?.["pendingDue"];
		if (pending === null || typeof pending !== "object" || typeof pending["to"] !== "number") return {
			settled: false,
			reason: "none"
		};
		const now = this.now();
		if (input.accept === true) this.store.updateFactDue(fact.id, {
			from: typeof pending["from"] === "number" ? pending["from"] : pending["to"],
			to: pending["to"],
			kind: typeof pending["kind"] === "string" ? pending["kind"] : "relative",
			precision: typeof pending["precision"] === "string" ? pending["precision"] : "day",
			phrase: typeof pending["phrase"] === "string" ? pending["phrase"] : null
		}, now, {
			previousDue: {
				from: fact.dueFrom,
				to: fact.expiresAt,
				phrase: fact.evidence?.["ttlPhrase"] ?? null
			}
		});
		else {
			const evidence = { ...fact.evidence };
			delete evidence.pendingDue;
			this.store.updateFactState(fact.id, {
				evidence,
				updatedAt: now
			});
		}
		this.store.audit(input.identity.id, input.accept === true ? "due.accept" : "due.reject", "fact", String(fact.id), { pending }, now);
		// The block was rendered from a cached result; it still carries the
		// question we just answered.
		this.#recallCache.clear();
		return {
			settled: true,
			accepted: input.accept === true,
			fact
		};
	}
	/**
	* Record how a plan ended — three ways, at two different moments.
	*
	* The plan is not edited. It stays as the thing that was said, and a new
	* fact carries the outcome — 「用户打算去看房子」 was true when it was said,
	* 「已办成（11-06 确认）」 is true now. Overwriting the first with the second
	* would delete the only record of the promise, which is exactly what the
	* next question is about.
	*
	* All three endings are stored. "没办成" is not a failure to record; it is
	* the more informative of the two yes/no answers, and a memory that only
	* keeps successes is a memory that will happily suggest the same failed
	* plan again. "已取消" is a third thing again: nothing was tried, the user
	* changed their mind. Storing it as `missed` would make the memory say
	* 「他没去成」 about a plan he consciously dropped — and then keep the
	* advice that followed from wanting it in the first place.
	*
	* Nothing here looks at the deadline. The same call serves the overdue
	* answer ("去了/没去") and the early one ("发了"/"不去了"): a plan can end
	* before its date, and waiting for the date to record it would only produce
	* a question the user has already answered.
	* @param input - the plan id, one of the three endings, the caller and an optional note.
	* @returns the new fact id, or why nothing was written.
	*/
	resolve(input) {
		const fact = this.store.getFact(input.id);
		if (fact === void 0) return { resolved: false, reason: "missing" };
		if (fact.identityId !== input.identity.id && input.identity.role !== "master") return { resolved: false, reason: "denied" };
		if (fact.kind !== "plan") return { resolved: false, reason: "not-plan" };
		if ((fact.resolvedAt ?? null) !== null) return {
			resolved: false,
			reason: "already",
			outcome: fact.outcome
		};
		/*
		* Refuse an unknown ending instead of guessing one. The tool's schema
		* already restricts the value, so this can only fire from a direct engine
		* call — and a direct caller that writes `undefined` should be told, not
		* silently filed under "missed".
		*/
		if (!isPlanOutcome(input.outcome)) return { resolved: false, reason: "bad-outcome" };
		const now = this.now();
		const outcome = input.outcome;
		const zone = this.timezoneOf(input.sessionId ?? "");
		const day = shortDate(now, zone, now, this.config.locale);
		const note = typeof input.note === "string" && input.note.trim().length > 0 ? clip(input.note.trim(), 60) : null;
		const said = PLAN_ENDINGS[outcome][this.config.locale];
		const clause = this.config.locale === "en" ? `${said} (confirmed ${day})` : `${said}（${day} 确认）`;
		const text = clip(`${fact.text} —— ${clause}${note === null ? "" : `，${note}`}`, 800);
		const factId = this.store.insertFact({
			identityId: fact.identityId,
			text,
			kind: "fact",
			source: "manual",
			domain: fact.domain,
			tags: [fact.domain, "fact"],
			salience: fact.salience,
			base: fact.base,
			stability: this.config.decay.sInitial,
			stabilityMax: this.config.decay.sInitial * this.config.decay.sMaxMultiplier,
			confidence: .95,
			ttl: "none",
			expiresAt: null,
			dueFrom: null,
			fromVisitor: fact.fromVisitor,
			evidence: {
				resolvedPlan: fact.id,
				outcome
			},
			aliases: [],
			aliasLimit: 0,
			createdAt: now,
			updatedAt: now
		});
		this.store.resolvePlan(fact.id, outcome, now);
		/*
		* The time proposal dies with the question. Keeping it would leave a
		* settled row counted among "条时间待确认" in `memory_doctor` forever —
		* an owed item nobody can ever pay.
		*/
		if (fact.evidence?.["pendingDue"] !== void 0) {
			const evidence = { ...fact.evidence };
			delete evidence.pendingDue;
			this.store.updateFactState(fact.id, {
				evidence,
				updatedAt: now
			});
		}
		this.store.audit(fact.identityId, "plan.resolve", "fact", String(fact.id), {
			outcome,
			factId,
			note
		}, now);
		this.#recallCache.clear();
		return {
			resolved: true,
			id: fact.id,
			factId,
			outcome
		};
	}
	/** The profile tool's payload: persona, narrative, impression and counters. */
	profile(identityId) {
		const identity = this.store.getIdentity(identityId);
		const impression = this.store.getImpression(identityId);
		return {
			persona: this.personaFor(identityId),
			narrative: this.store.currentNarrative()?.text ?? null,
			impression: impression?.text ?? null,
			facts: this.store.countFacts(identityId),
			events: this.store.recentEvents(identityId, 200).length,
			diary: this.store.countDiary(identityId),
			role: identity?.role ?? "visitor",
			name: identity?.name ?? identityId
		};
	}
	/** Apply a persona write from the master. */
	writePersona(input) {
		return writePersona({
			...input,
			store: this.store,
			now: this.now()
		});
	}
	/** Lock or unlock a persona zone. */
	lockPersona(zone, locked, confirmed) {
		return setLock(this.store, this.now(), zone, locked, confirmed);
	}
	/** Schedule or perform deletion for an identity. */
	erase(input) {
		return requestDeletion({
			store: this.store,
			config: this.config,
			identity: input.identity,
			actor: input.actor,
			now: this.now(),
			keepFacts: input.keepFacts
		});
	}
	/** Erase a visitor's raw turns while keeping their facts flagged and dimmed. */
	degradeVisitor(identity) {
		return markVisitorFacts(this.store, identity.id, this.now());
	}
	/** Export one identity's memory as a plain object; the master may export all. */
	exportData(identityId) {
		const identity = this.store.getIdentity(identityId);
		return {
			exportedAt: new Date(this.now()).toISOString(),
			identity: identity ?? null,
			persona: this.store.personaZones(),
			overlays: this.store.personaOverlays(identityId),
			narrative: this.store.currentNarrative()?.text ?? null,
			impression: this.store.getImpression(identityId) ?? null,
			facts: this.store.factsForIdentity(identityId, 1e4),
			events: this.store.recentEvents(identityId, 1e4),
			diary: this.store.recentDiary(identityId, 1e4),
			preferences: this.store.db.prepare("SELECT id, text, created_at, active FROM preferences WHERE identity_id = ?").all(identityId)
		};
	}
	/** Aggregate counters for the profile and status tools. */
	stats(identityId) {
		const identity = this.store.getIdentity(identityId);
		return {
			facts: this.store.countFacts(identityId),
			events: this.store.recentEvents(identityId, 200).length,
			l0: this.store.countL0(identityId),
			deadLetters: this.store.deadJobCount(),
			role: identity?.role ?? "visitor"
		};
	}
	/** Whether the model bridge is configured at all. */
	get hasModel() {
		return this.#llm !== void 0;
	}
};

//#endregion
//#region src/engine/intake.ts
/**
* 把别的记忆插件留下的记忆搬进来。
*
* 为什么需要这一层：换插件不该等于丢掉过去。至少四个记忆插件共用
* `memory_search` / `memory_write` / `memory_forget`，撞名之后用户只有两条路 ——
* 卸掉对方（它的文件还留在盘上，但再没人读），或者让本插件改名共存。两条路都留下
* 同一堆孤儿文件，而「记忆」这个产品最不能接受的就是「换一次插件就从零开始」。
*
* 三层分工，每一层都能单独失败：
*   1. 扫描 `scanIntake` —— 只找、只数，不读内容。结果落在 meta 里，提示词和医生读它，
*      所以「有没有东西可导」这件事实时可见，而每轮对话不必碰一次磁盘。
*   2. 预览 `readIntakeSource` + `planIntake` —— 读一份文件、认出格式、给出清单与代价，不写库。
*   3. 落库 `writeIntake` —— 走与整合完全相同的分类与写入路径，只是多带一个来源标记。
*
* 三条硬规矩：
*   - 不自动导入。别人的记忆是他的东西，搬不搬由他说。
*   - 不删、不改源文件。搬家没有「顺手清空旧房子」这一步；卸载别的插件也不删它的数据，
*     所以导入之后那两个文件必须原样留着。
*   - 不编造时间。行按原文件的创建时间落库，年龄照算；但稳定性按年龄补齐
*     （`importedStability`），否则一条两年前的记忆一进来就被衰减判死，导了等于没导。
*/
/** How often the maintenance tick re-checks the disk for orphaned memory files. */
const INTAKE_SCAN_MS = 6 * 36e5;
/** A file bigger than this is reported and skipped: it is not a memory file. */
const INTAKE_MAX_BYTES = 16 * 1024 * 1024;
/** Row cap per source, per import. A silently truncated import is worse than a slow one. */
const INTAKE_MAX_ROWS = 2000;
/** One imported row longer than this keeps its head and says so. */
const INTAKE_MAX_CHARS = 400;
/** Rows per model call when rebuilding aliases. */
const INTAKE_ALIAS_BATCH = 12;
/** How many turns a session may be told about an unimported store before it goes quiet. */
const INTAKE_NOTICE_TURNS = 3;
/**
* Columns that carry the sentence, in preference order.
*
* Order matters: `summary` and `title` come last because a plugin that keeps both
* a body and a summary means the body is the memory and the summary is a label.
*/
const INTAKE_TEXT_FIELDS = [
	"text",
	"content",
	"memory",
	"body",
	"fact",
	"value",
	"entry",
	"note",
	"sentence",
	"summary"
];
const INTAKE_TAG_FIELDS = [
	"tags",
	"keywords",
	"labels",
	"label",
	"topic"
];
const INTAKE_KIND_FIELDS = [
	"kind",
	"type",
	"category",
	"scope",
	"namespace"
];
const INTAKE_TIME_FIELDS = [
	"created_at",
	"createdAt",
	"created",
	"at",
	"time",
	"timestamp",
	"ts",
	"updated_at",
	"updatedAt"
];
const INTAKE_PIN_FIELDS = [
	"pinned",
	"pin",
	"starred",
	"sticky"
];
const INTAKE_ID_FIELDS = [
	"id",
	"uuid",
	"key"
];
/** Where a JSON store keeps its array, when it is not the document root. */
const INTAKE_ARRAY_FIELDS = [
	"memories",
	"blocks",
	"items",
	"facts",
	"entries",
	"records",
	"notes",
	"list",
	"store",
	"data"
];
/** Files worth looking at. Anything else in a memory directory is somebody's config. */
const INTAKE_FILE = /\.(?:db|sqlite|sqlite3|json|jsonl|ndjson|md|markdown|txt)$/iu;
/** A directory or file name that suggests a memory store. */
const INTAKE_NAME_HINT = /(?:memor|记忆)/iu;
/** Row kinds other plugins use, mapped onto ours. */
const INTAKE_KINDS = new Map([
	["fact", "fact"],
	["facts", "fact"],
	["note", "fact"],
	["memory", "fact"],
	["preference", "preference"],
	["preferences", "preference"],
	["pref", "preference"],
	["like", "preference"],
	["instruction", "instruction"],
	["instructions", "instruction"],
	["rule", "instruction"],
	["rules", "instruction"],
	["prompt", "instruction"],
	["convention", "instruction"],
	["constraint", "instruction"],
	["plan", "plan"],
	["todo", "plan"],
	["task", "plan"],
	["intent", "plan"],
	["relationship", "relationship"],
	["person", "relationship"],
	["people", "relationship"]
]);
/**
* Recognisable file names, so the preview can name the plugin instead of a path.
*
* Not a whitelist — anything that reads as memories gets imported. This only
* decides what to *call* it, because 「一份 42 条记忆」 和 「dsh-memory 的 42 条记忆」
* 是两句可信度不同的话。
*/
const INTAKE_KNOWN_FILES = [
	{
		file: /^loom(?:[-_.][^/\\]*)?\.db$/iu,
		plugin: "memory-loom（本插件自己的旧库）"
	},
	{ file: /^memory\.db$/iu, plugin: "dsh-memory" },
	{ file: /^memories\.db$/iu, plugin: "其它记忆插件" },
	{
		file: /^memory(?:_project)?(?:_[0-9a-z]+)?\.json$/iu,
		plugin: "@max-null/dsh-memory 或同款 JSON 存储"
	}
];
/**
* A column that means the table holds a conversation, not memories.
*
* Applied before anything is read: importing one's raw turns as facts is the
* worst possible failure of this feature — it looks like success, it doubles
* every conversation into the retrieval layer, and the only symptom is that
* search slowly fills with things the user said to somebody else.
*/
const INTAKE_TRANSCRIPT_COLUMNS = ["role", "speaker", "direction"];
/** Tables that live in a memory store but are not memories: settings, indexes, persona, logs. */
const INTAKE_SKIP_TABLE = /^(?:sqlite_|meta$|audit$|jobs$|traces$|usage|sessions?$|identit|persona|narrative$|impressions$|diary$|loom_|memory_edges$|event_facts$)|_fts/iu;
/** A table name that suggests memories rather than anything else in the file. */
const INTAKE_TABLE_HINT = /(?:memor|fact|note|item|record|entr(?:y|ies)|block|store|thought|knowledge|prefer|instruction)/iu;
/** Quote an identifier taken from `sqlite_master` so a table called `memory-data` still works. */
function quoteIdent(name) {
	return `"${name.replaceAll("\"", "\"\"")}"`;
}
/** The format a path is read as. Extension only — sniffing BOMs buys nothing here. */
function intakeFormatOf(path) {
	const lower = path.toLowerCase();
	if (lower.endsWith(".db") || lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")) return "sqlite";
	if (lower.endsWith(".json")) return "json";
	if (lower.endsWith(".jsonl") || lower.endsWith(".ndjson")) return "jsonl";
	return "text";
}
/**
* The harness home, derived from the store's own location.
*
* The shipped patch row puts the store at `<home>/memory/loom.db`, and every
* other memory plugin in this ecosystem does the same thing with its own file
* (`<home>/memory/memory.db`, `<home>/storages/memory.json`). So the parent of
* the `memory` directory *is* the home in practice, and that is enough to find
* the neighbours — no new config knob, no dependency on how the host was
* started. `$DSH_HOME` wins when it is set, because a relocated store must not
* silently point the scan at the old home.
* @param config - plugin config (only `path` is used).
* @returns the directory whose children to scan, or null when it cannot be known.
*/
function intakeHome(config) {
	const fromEnv = (process.env.DSH_HOME ?? "").trim();
	if (fromEnv.length > 0) return resolve(fromEnv);
	const dir = dirname(config.path);
	if (dir === "." || dir === "/" || dir.length === 0) return null;
	if (basename(dir) === "memory") return dirname(dir);
	return dir;
}
/** Name the plugin behind a file, or say the name is unknown. */
function intakePluginFor(path) {
	const name = basename(path);
	for (const known of INTAKE_KNOWN_FILES) if (known.file.test(name)) return known.plugin;
	return "未知记忆插件";
}
/** A short, stable label for prompts and reports: plugin name plus file name. */
function intakeLabel(entry) {
	return `${entry.plugin}（${basename(entry.path)}）`;
}
/** The identity of a file's current revision: enough to tell "unchanged" from "grew". */
function intakeFingerprint(entry) {
	return `${entry.bytes}:${entry.mtime}`;
}
/** Read one meta value that holds JSON, tolerating anything that is not. */
function intakeMeta(store, key, fallback) {
	try {
		const raw = store.getMeta(key);
		if (typeof raw !== "string" || raw.length === 0) return fallback;
		const value = JSON.parse(raw);
		return value;
	} catch {
		return fallback;
	}
}
/**
* The sources still worth offering: not dismissed, and not already imported
* since their last change.
*
* The fingerprint is what makes re-offering honest. A file the user already
* imported goes quiet — but if the other plugin wrote more memories after that,
* the file changed, and the new rows are exactly what a second offer would bring.
* @param store - the store holding the scan result.
* @returns entries from the last scan that nobody has answered yet.
*/
function pendingIntake(store) {
	const scanned = intakeMeta(store, "intake.scan", []);
	const dismissed = new Set(intakeMeta(store, "intake.dismissed", []));
	const imported = intakeMeta(store, "intake.imported", {});
	const out = [];
	for (const entry of Array.isArray(scanned) ? scanned : []) {
		if (typeof entry?.path !== "string") continue;
		if (dismissed.has(entry.path)) continue;
		const done = imported[entry.path];
		if (typeof done === "object" && done !== null && done.fingerprint === intakeFingerprint(entry)) continue;
		out.push(entry);
	}
	return out;
}
/** The candidate tables of a SQLite file: those carrying a text column and at least one row. */
function intakeTables(db) {
	const tables = [];
	for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
		const name = String(row["name"]);
		// `sqlite_*` is the engine's own bookkeeping; `*_fts*` is a shadow copy of a
		// table we already have. Reading either would double every row.
		if (name.startsWith("sqlite_") || /_fts/iu.test(name)) continue;
		if (INTAKE_SKIP_TABLE.test(name)) continue;
		let columns;
		try {
			columns = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all().map((column) => String(column["name"]));
		} catch {
			continue;
		}
		// A transcript table passes every other test — it has `text` and rows — so
		// the speaker column is what distinguishes 「他说过的话」 from 「他的记忆」.
		if (INTAKE_TRANSCRIPT_COLUMNS.some((column) => columns.includes(column))) continue;
		const text = INTAKE_TEXT_FIELDS.find((field) => columns.includes(field));
		if (text === undefined) continue;
		tables.push({
			name,
			columns,
			text,
			order: INTAKE_TIME_FIELDS.find((field) => columns.includes(field)) ?? null
		});
	}
	/*
	* Names first, everything else as a fallback. A store that has a `memories`
	* table and also a `scratch` table means the first is the memories; a store
	* with only `kv` means we have no name to go on and must read it anyway.
	*/
	const hinted = tables.filter((table) => INTAKE_TABLE_HINT.test(table.name));
	return hinted.length > 0 ? hinted : tables;
}
/**
* Read a SQLite memory file without touching it.
*
* Opened `readOnly`, so a foreign plugin that is still installed keeps its
* writer lock and nothing here can corrupt a store we do not own. WAL files are
* readable this way as long as the `-wal` sibling is readable too, which it is.
* @param path - the database file.
* @param limit - rows to actually read (the count is always complete).
* @returns records, the total row count, and a note when something was skipped.
*/
function readIntakeSqlite(path, limit) {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const records = [];
		let total = 0;
		let notes = 0;
		for (const table of intakeTables(db)) {
			/*
			* One table at a time, each in its own catch. A store with a readable
			* `memories` and an odd `blobs` table must still import the memories;
			* letting one failure abort the file turns a partial success into
			* 「读不出来」, which is the least useful answer possible.
			*/
			try {
				const where = `${quoteIdent(table.text)} IS NOT NULL AND TRIM(${quoteIdent(table.text)}) <> ''`;
				const count = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table.name)} WHERE ${where}`).get()["n"]);
				if (count === 0) continue;
				total += count;
				const remaining = limit - records.length;
				if (remaining <= 0) continue;
				const rows = intakeTableRows(db, table, where, Math.max(1, remaining));
				for (const row of rows) records.push({
					...row,
					__text: row[table.text],
					__table: table.name
				});
			} catch {
				notes++;
			}
		}
		return {
			records,
			total,
			note: notes > 0 ? `有 ${notes} 张表读不出来，跳过了` : ""
		};
	} finally {
		try {
			db.close();
		} catch {}
	}
}
/**
* Rows of one table, oldest first.
*
* `rowid` is the only ordering a foreign table is guaranteed to have — and even
* that fails on a `WITHOUT ROWID` table, where the first attempt throws with
* "no such column". The retry reads in whatever order the file gives, which for
* every store seen so far is insertion order.
*/
function intakeTableRows(db, table, where, limit) {
	const order = table.order === null ? "rowid" : quoteIdent(table.order);
	try {
		return db.prepare(`SELECT * FROM ${quoteIdent(table.name)} WHERE ${where} ORDER BY ${order} ASC LIMIT ${limit}`).all();
	} catch {
		return db.prepare(`SELECT * FROM ${quoteIdent(table.name)} WHERE ${where} LIMIT ${limit}`).all();
	}
}
/** The records inside a parsed JSON document, wherever the plugin kept them. */
function intakeRecordsOf(value) {
	if (Array.isArray(value)) return value;
	if (typeof value !== "object" || value === null) return [];
	for (const key of INTAKE_ARRAY_FIELDS) {
		const found = value[key];
		if (Array.isArray(found)) return found;
		if (typeof found === "object" && found !== null) return Object.values(found);
	}
	const values = Object.values(value);
	// `{"1": "…", "2": "…"}` and `["…", "…"]` are what an export button writes
	// when it has no schema to follow, and both are memories. Told apart from a
	// settings document by requiring every value to be a non-empty string.
	if (values.length > 0 && values.every((item) => typeof item === "string" && item.trim().length > 0)) return values;
	if (values.length > 0 && values.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) return values;
	return [];
}
/** Whether a parsed JSON value can be one memory: a sentence, or a record holding one. */
function intakeIsRecord(value) {
	return typeof value === "string" ? value.trim().length > 0 : typeof value === "object" && value !== null;
}
/**
* Read a JSON or JSONL memory file.
* @param raw - file contents.
* @param limit - rows to read; the count is complete either way.
* @param lines - true for one-object-per-line files.
* @returns records and the total count.
*/
function readIntakeJson(raw, limit, lines) {
	const records = [];
	let total = 0;
	if (lines) {
		for (const line of raw.split(/\r?\n/u)) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			let value;
			try {
				value = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (!intakeIsRecord(value)) continue;
			total++;
			if (records.length < limit) records.push(value);
		}
		return {
			records,
			total,
			note: ""
		};
	}
	const parsed = JSON.parse(raw);
	for (const value of intakeRecordsOf(parsed)) {
		if (!intakeIsRecord(value)) continue;
		total++;
		if (records.length < limit) records.push(value);
	}
	return {
		records,
		total,
		note: ""
	};
}
/**
* Read a Markdown or plain-text memory file: one memory per bullet or line.
*
* This is the格式 of every "export your memories" button that exists, and of
* the notes people keep by hand, so it is worth supporting even though it
* carries no dates and no tags.
* @param raw - file contents.
* @param limit - rows to read.
* @returns records shaped like every other source.
*/
function readIntakeLines(raw, limit) {
	const records = [];
	let total = 0;
	let heading = "";
	for (const line of raw.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const headingMatch = /^#{1,6}\s+(.+)$/u.exec(trimmed);
		if (headingMatch !== null) {
			heading = headingMatch[1].trim();
			continue;
		}
		if (/^(?:```|~~~|---|===|\|)/u.test(trimmed)) continue;
		const bullet = /^(?:[-*+•]|\d+[.)、])\s+(.+)$/u.exec(trimmed);
		const text = bullet === null ? trimmed : bullet[1];
		if (text.length < 4) continue;
		total++;
		if (records.length >= limit) continue;
		records.push(heading.length > 0 ? {
			text,
			tags: heading
		} : { text });
	}
	return {
		records,
		total,
		note: ""
	};
}
/**
* Read one source file into raw records.
*
* Every failure is a return value, never a throw: a corrupt foreign file is the
* normal case here (that plugin may have been uninstalled mid-write), and a
* throw would take down the report that is supposed to explain it.
* @param entry - a scanned entry (needs `path` and `bytes`).
* @param limit - rows to read.
* @returns records plus the format, total count and any note.
*/
function readIntakeSource(entry, limit) {
	const format = intakeFormatOf(entry.path);
	if (entry.bytes > INTAKE_MAX_BYTES) return {
		ok: false,
		format,
		records: [],
		total: 0,
		note: `文件 ${humanSize(entry.bytes)}，超过 ${humanSize(INTAKE_MAX_BYTES)}，没读`
	};
	try {
		if (format === "sqlite") {
			const read = readIntakeSqlite(entry.path, limit);
			return {
				ok: true,
				format,
				...read
			};
		}
		const raw = readFileSync(entry.path, "utf8");
		const read = format === "json" ? readIntakeJson(raw, limit, false) : format === "jsonl" ? readIntakeJson(raw, limit, true) : readIntakeLines(raw, limit);
		return {
			ok: true,
			format,
			...read
		};
	} catch (error) {
		return {
			ok: false,
			format,
			records: [],
			total: 0,
			note: clip(String(error?.message ?? error), 80)
		};
	}
}
/** The sentence inside a foreign record. */
function intakeTextOf(raw) {
	if (typeof raw === "string") return raw;
	if (typeof raw !== "object" || raw === null) return "";
	if (typeof raw["__text"] === "string") return raw["__text"];
	for (const field of INTAKE_TEXT_FIELDS) {
		const value = raw[field];
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return "";
}
/** The tag list inside a foreign record, split from a string or copied from an array. */
function intakeTagsOf(raw) {
	if (typeof raw !== "object" || raw === null) return [];
	const out = [];
	for (const field of INTAKE_TAG_FIELDS) {
		const value = raw[field];
		const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,，;；\s|]+/u) : [];
		for (const part of parts) {
			if (typeof part !== "string") continue;
			const tag = squeeze(part).toLowerCase();
			if (tag.length === 0 || tag.length > 24) continue;
			if (!out.includes(tag)) out.push(tag);
			if (out.length >= 6) return out;
		}
	}
	return out;
}
/** Whether a foreign record was pinned — every plugin spells this differently. */
function intakePinnedOf(raw) {
	if (typeof raw !== "object" || raw === null) return false;
	for (const field of INTAKE_PIN_FIELDS) {
		const value = raw[field];
		if (value === true || value === 1) return true;
		if (typeof value === "string" && /^(?:1|true|yes|pinned)$/iu.test(value.trim())) return true;
	}
	return false;
}
/** The kind a foreign record claims, mapped onto ours, falling back to the same classifier we use for dialogue. */
function intakeKindOf(raw, text) {
	if (typeof raw === "object" && raw !== null) for (const field of INTAKE_KIND_FIELDS) {
		const value = raw[field];
		if (typeof value !== "string") continue;
		const mapped = INTAKE_KINDS.get(value.trim().toLowerCase());
		if (mapped !== undefined) return mapped;
	}
	return parseKind(void 0, text);
}
/** The moment a foreign row was written, in milliseconds — or null when the file does not say. */
function intakeTimeOf(raw, now) {
	if (typeof raw !== "object" || raw === null) return null;
	for (const field of INTAKE_TIME_FIELDS) {
		const value = raw[field];
		const numeric = typeof value === "number" ? value : typeof value === "string" && /^\d{9,14}$/u.test(value.trim()) ? Number(value.trim()) : Number.NaN;
		if (!Number.isFinite(numeric) || numeric <= 0) continue;
		// Seconds or milliseconds: anything before 1973 in milliseconds is a second
		// stamp, and no memory is that old.
		const ms = numeric < 1e11 ? Math.round(numeric * 1e3) : Math.round(numeric);
		if (ms <= 0) continue;
		// A clock-skewed file must not produce a memory from 2038.
		return ms > now + DAY_MS ? now : ms;
	}
	return null;
}
/** The stable id of a foreign row, kept only to describe it ("第 17 条"). */
function intakeIdOf(raw) {
	if (typeof raw !== "object" || raw === null) return null;
	for (const field of INTAKE_ID_FIELDS) {
		const value = raw[field];
		if (typeof value === "number" || typeof value === "string") return String(value);
	}
	return null;
}
/**
* Whether a foreign row says it is no longer in force.
*
* `preferences` has an `active` column, and since 0.2.28 something finally
* writes 0 into it. Without this check, importing from another install (or from
* our own `memory_export`) would resurrect every rule the user had retired —
* the one thing the retire path exists to prevent. Only the explicit flags are
* read; an unknown shape is treated as active, because refusing to import is
* louder than importing something the user can then forget.
* @param raw - one foreign record.
* @returns true when the record marks itself inactive.
*/
function intakeRowRetired(raw) {
	if (typeof raw !== "object" || raw === null) return false;
	const active = raw["active"];
	return active === 0 || active === "0" || active === false || active === "false";
}
/**
* Turn raw foreign records into rows this store can take.
*
* The filters are the same ones the dialogue path applies, for the same
* reasons: a four-character fragment is not a memory, a credential must never
* be copied into a second file, and an over-long row is a paragraph somebody
* pasted rather than a fact — it keeps its head and is counted.
* @param records - raw records from one source.
* @param plugin - where they came from.
* @param now - clock, for records that carry no date.
* @returns accepted rows and what was dropped, by reason.
*/
function normalizeIntakeRows(records, plugin, now) {
	const rows = [];
	const dropped = {
		short: 0,
		secret: 0,
		long: 0,
		retired: 0
	};
	for (const raw of records) {
		if (intakeRowRetired(raw)) {
			dropped.retired++;
			continue;
		}
		const text = squeeze(intakeTextOf(raw));
		if (text.length < 4) {
			dropped.short++;
			continue;
		}
		if (containsSecret(text)) {
			dropped.secret++;
			continue;
		}
		let kept = text;
		if (text.length > INTAKE_MAX_CHARS) {
			kept = `${text.slice(0, INTAKE_MAX_CHARS)}…`;
			dropped.long++;
		}
		rows.push({
			text: kept,
			kind: intakeKindOf(raw, kept),
			tags: intakeTagsOf(raw),
			pinned: intakePinnedOf(raw),
			createdAt: intakeTimeOf(raw, now),
			externalId: intakeIdOf(raw),
			plugin
		});
		if (rows.length >= INTAKE_MAX_ROWS) break;
	}
	return {
		rows,
		dropped
	};
}
/**
* Scan the disk for memory files left by other plugins.
*
* Bounded on purpose: three `readdir` calls and one open per candidate, no
* recursion. A startup that walks the home directory would show up as a slow
* boot on machines with a large `~/.dsh`, and the payoff would be zero — every
* plugin that stores memories here uses one of these three shapes.
* @param config - plugin config, for the home and our own file name.
* @returns entries with `path`, `plugin`, `format`, `bytes`, `mtime`, `rows` (null when unreadable).
*/
function scanIntake(config) {
	const home = intakeHome(config);
	const candidates = [];
	const push = (path) => {
		if (candidates.some((entry) => entry.path === path)) return;
		candidates.push(path);
	};
	const consider = (dir, filter) => {
		let names;
		try {
			names = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const item of names) {
			if (!item.isFile()) continue;
			if (!INTAKE_FILE.test(item.name)) continue;
			if (filter !== void 0 && !filter(item.name)) continue;
			push(join(dir, item.name));
		}
	};
	if (home !== null) {
		// The `memory` directory next to our own store: one plugin, one file.
		consider(join(home, "memory"), (name) => !/^loom\.db(?:-(?:wal|shm))?$/u.test(name));
		// Storage-layer JSON (`$DSH_HOME/storages/memory.json`).
		consider(join(home, "storages"), (name) => INTAKE_NAME_HINT.test(name));
		// One level deeper, for plugins that own a directory of their own.
		let subdirs;
		try {
			subdirs = readdirSync(home, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name);
		} catch {
			subdirs = [];
		}
		for (const name of subdirs) {
			if (name === "memory" || name === "storages" || name.startsWith(".")) continue;
			consider(join(home, name), (file) => INTAKE_NAME_HINT.test(file) || INTAKE_NAME_HINT.test(name));
		}
	}
	// A project-scoped memory file follows the repository, so it is not under the home.
	consider(join(process.cwd(), ".dsh", "storages"), (name) => INTAKE_NAME_HINT.test(name));
	const entries = [];
	const own = resolve(config.path);
	for (const path of candidates) {
		let stat;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		if (!stat.isFile() || stat.size === 0) continue;
		// Our own store, matched by absolute path: the name filter above already
		// skips `loom.db`, but a relocated or renamed store would slip through.
		if (resolve(path) === own) continue;
		const entry = {
			path,
			plugin: intakePluginFor(path),
			format: intakeFormatOf(path),
			bytes: stat.size,
			mtime: Math.round(stat.mtimeMs),
			rows: null,
			note: ""
		};
		const read = readIntakeSource(entry, 1);
		entry.rows = read.ok ? read.total : null;
		entry.note = read.note;
		entries.push(entry);
	}
	entries.sort((a, b) => b.mtime - a.mtime);
	return entries.slice(0, 8);
}
/**
* Decide what a source would add, without writing anything.
*
* Duplicates are matched by exact text against the live store, which is the
* same ledger a second import consults — no side table to drift, and deleting a
* memory then re-importing it brings it back, which is what a person expects.
* @param store - the store to compare against.
* @param identityId - whose memories these will become.
* @param rows - normalized rows from one source.
* @returns accepted rows with kind/domain assigned, plus the drop counts.
*/
function planIntake(store, identityId, rows) {
	const existing = new Set();
	let known;
	try {
		known = store.factsForIdentity(identityId, 5000);
	} catch {
		known = [];
	}
	for (const fact of known) existing.add(squeeze(fact.text));
	// Standing instructions are not facts. Without this second ledger, importing
	// the same file twice grows one preference row per run — silently, because
	// 事实 那条线一条都没动。
	try {
		for (const text of store.preferenceTexts(identityId)) existing.add(squeeze(text));
	} catch {}
	const seen = new Set();
	const accept = [];
	let duplicates = 0;
	let downgraded = 0;
	for (const row of rows) {
		const key = squeeze(row.text);
		if (key.length === 0) continue;
		if (existing.has(key) || seen.has(key)) {
			duplicates++;
			continue;
		}
		seen.add(key);
		/*
		* A plan is a promise this engine will follow up on a date it computed.
		* A foreign row has no usable date — the phrase 「下周三」 was resolved
		* against *that* plugin's clock, and re-resolving it against today would
		* invent a deadline. So an imported plan is stored as a fact and keeps
		* its wording; it is not a thing to chase.
		*/
		const plan = row.kind === "plan";
		if (plan) downgraded++;
		accept.push({
			...row,
			kind: plan ? "fact" : row.kind,
			domain: detectDomain(row.text).domain,
			salience: readEmotion(row.text).salience,
			wasPlan: plan
		});
	}
	return {
		accept,
		duplicates,
		downgraded
	};
}
/**
* Stability for an imported row, floored by its own age.
*
* Without this, an import is a silent no-op for anything old: strength is
* `base × (1 + age/S)^-d`, so a two-year-old row entering at `sInitial` lands
* at a seventh of a fresh one and never clears a relevance floor. We did not
* observe those two years of neglect, so we do not charge for them — an
* imported memory starts at half strength and grows from there.
* @param config - decay settings.
* @param ageDays - how old the row is.
* @returns stability in days, never below `sInitial`.
*/
function importedStability(config, ageDaysValue) {
	return Math.max(config.decay.sInitial, Math.max(0, ageDaysValue));
}
/**
* Write an import.
*
* The path is deliberately the same one consolidation uses: instructions go to
* the preference table (they are resident, not recalled), everything else
* becomes a fact with a domain, a kind, a salience and a source. Nothing here
* invents a due date, and nothing here calls a model — aliases are a separate,
* explicitly-priced step.
* @param deps - engine and config.
* @param plan - output of `planIntake`.
* @param plugin - source label, recorded on every row.
* @param now - write clock.
* @returns counts by outcome.
*/
function writeIntake(deps, plan, plugin, now) {
	const { engine, config } = deps;
	const store = engine.store;
	const identity = store.ensureMaster(MASTER_ID, config.ownerName, now);
	const byKind = {};
	let preferences = 0;
	for (const row of plan.accept) {
		const at = row.createdAt ?? now;
		if (row.kind === "instruction") {
			store.insertPreference(identity.id, row.text, null, at);
			preferences++;
			byKind["instruction"] = (byKind["instruction"] ?? 0) + 1;
			continue;
		}
		const stability = importedStability(config, ageDays(now, at));
		const id = store.insertFact({
			identityId: identity.id,
			text: row.text,
			kind: row.kind,
			source: `import:${plugin}`,
			domain: row.domain,
			tags: [row.domain, row.kind, plugin],
			salience: row.salience,
			base: baseFromSalience(row.salience),
			stability,
			stabilityMax: Math.max(stability * config.decay.sMaxMultiplier, stability),
			confidence: .6,
			ttl: "none",
			expiresAt: null,
			dueFrom: null,
			pinned: row.pinned,
			fromVisitor: false,
			isolated: false,
			sourceIds: [],
			evidence: {
				importedFrom: plugin,
				importedAt: now,
				originalAt: row.createdAt,
				wasPlan: row.wasPlan === true || void 0,
				externalId: row.externalId
			},
			aliases: [],
			aliasLimit: config.consolidation.aliasCount,
			createdAt: at,
			updatedAt: at
		});
		// The foreign tags are not just metadata: they go into the same `tokens`
		// column and the same index as the text, so a row stored with its original
		// tags is findable by the words its own author filed it under.
		if (id > 0 && (row.tags ?? []).length > 0) store.updateFactText(id, row.text, [row.domain, row.kind, plugin, ...row.tags], row.salience, baseFromSalience(row.salience), at);
		byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
	}
	store.audit(MASTER_ID, "intake.import", "fact", null, {
		plugin,
		facts: plan.accept.length - preferences,
		preferences,
		duplicates: plan.duplicates
	}, now);
	return {
		identity,
		byKind,
		preferences,
		facts: plan.accept.length - preferences
	};
}
/** "tech 12 · money 3" — the domain spread of a plan, biggest first. */
function intakeSpread(list, pick) {
	const counts = new Map();
	for (const row of list) {
		const key = pick(row);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => `${key} ${count}`).join(" · ");
}
/** How many model calls a batch of facts costs at the current batch size. */
function intakeCallEstimate(rows) {
	return Math.ceil(rows / INTAKE_ALIAS_BATCH);
}
/**
* The prompt that rebuilds aliases for facts that have none.
*
* Same rule as the extraction prompt, and for the same measured reason: an
* alias is the words the user would *ask* with, not another name for the thing.
* Applied to imported rows it matters more, not less — those sentences were
* written by a different product's prompt, so they share even less vocabulary
* with the way this user talks today.
* @param items - facts to write aliases for.
* @param locale - output language.
* @param limit - aliases per fact.
* @returns the user prompt.
*/
function aliasBackfillPrompt(items, locale, limit) {
	const language = locale === "zh" ? "中文" : "English";
	const lines = items.map((item, index) => `${index}. ${item.text}`);
	return [
		`给下面 ${items.length} 条记忆各补 ${limit} 个检索别名。用${language}输出。`,
		"",
		"规则：",
		"- 别名是「用户下次会用什么话问起这件事」，不是这件事的另一个名字。「下周三体检」的别名是「身体怎么样」「什么时候去查」；写「健康检查」等于没写，因为他不会那样问。",
		"- 每条 2–3 个，每个 ≤6 字，口语，带具体对象名（项目名 / 工具名 / 人名 / 地点）。",
		"- 不要「工作」「心情」「事情」这类泛词，不要只写「怎么样」这种离开对象就没意义的问句壳，不要照抄原句。",
		"- 一条实在想不出问法就给空数组，不要编。",
		"",
		"记忆：",
		...lines,
		"",
		"输出 JSON：",
		"{\"items\":[{\"i\":0,\"a\":[\"…\",\"…\"]}]}"
	].join("\n");
}
/** The alias-rebuild system message. */
const ALIAS_SYSTEM = "你是一个严谨的记忆检索助手。你只输出 JSON，不输出任何解释。";
/**
* Re-scan the disk, at most every `INTAKE_SCAN_MS` unless forced.
*
* The throttle is the whole reason this can sit in a 60-second tick: a rescan
* is a handful of `readdir` calls plus one open per candidate, which is fine
* once every six hours and pure waste every minute.
* @param config - plugin config.
* @param store - where the result is parked for the prompt and the doctor.
* @param options.force - scan now regardless of the last scan.
* @param options.now - clock.
* @returns the pending (not dismissed, not already imported) entries.
*/
function refreshIntake(config, store, options = {}) {
	const now = options.now ?? Date.now();
	if (options.force !== true) {
		const last = Number(store.getMeta("intake.scanAt") ?? 0);
		if (Number.isFinite(last) && now - last < INTAKE_SCAN_MS) return pendingIntake(store);
	}
	try {
		const entries = scanIntake(config);
		store.setMeta("intake.scanAt", String(now));
		store.setMeta("intake.scan", JSON.stringify(entries));
	} catch {
		// A scan failure must not erase the previous result: the old list is still
		// the best answer available, and an empty one reads as "nothing to offer".
	}
	return pendingIntake(store);
}
/**
* Remember that a source was imported at this revision.
*
* The fingerprint is what stops the offer from repeating: the next scan sees
* the same bytes and the same mtime, and `pendingIntake` drops it. If the other
* plugin writes another memory tomorrow, the file changes and the offer comes
* back — with only the new rows, because duplicates are matched by text.
* @param engine - for the store.
* @param entry - the source.
* @param plan - what was taken from it.
* @param now - clock.
*/
function recordImported(engine, entry, plan, now) {
	try {
		const imported = intakeMeta(engine.store, "intake.imported", {});
		const map = typeof imported === "object" && imported !== null && !Array.isArray(imported) ? imported : {};
		map[entry.path] = {
			at: now,
			fingerprint: intakeFingerprint(entry),
			rows: plan.accept.length,
			duplicates: plan.duplicates
		};
		engine.store.setMeta("intake.imported", JSON.stringify(map));
	} catch {}
}
/** The route a session last used, so a maintenance call follows the conversation. */
function routeOf(engine, sessionId) {
	const route = {};
	try {
		const session = engine.store.getSession(sessionId);
		if (typeof session?.lastProvider === "string" && session.lastProvider.length > 0) route.provider = session.lastProvider;
		if (typeof session?.lastModel === "string" && session.lastModel.length > 0) route.model = session.lastModel;
	} catch {}
	return route;
}
/** A date for a report line, degrading to ISO when the zone is unknown or the engine closed. */
function intakeStamp(ms, timezone) {
	try {
		return formatDateTime(ms, timezone);
	} catch {
		try {
			return new Date(ms).toLocaleString("zh-CN", { hour12: false });
		} catch {
			return String(ms);
		}
	}
}
/** One candidate on its own line: what it is, how much, where, and when it changed. */
function intakeEntryLine(entry, index, timezone) {
	const count = entry.rows === null ? (entry.note.length > 0 ? entry.note : "条数未知") : `${entry.rows} 条`;
	return `${index + 1}. ${intakeLabel(entry)} · ${count} · ${humanSize(entry.bytes)} · 修改于 ${intakeStamp(entry.mtime, timezone)}\n   ${entry.path}`;
}
/** The list a bare call returns: what is on disk, and what to do about it. */
function renderIntakeList(entries, timezone) {
	if (entries.length === 0) return "没找到别的记忆插件留下的记忆文件。如果你有一份导出的记忆文件，把路径给我（或把文件拖进聊天窗口）：memory_import(path=\"…\") 会先给你看清单，不写库。";
	return [
		`检测到 ${entries.length} 份别的记忆插件留下的记忆（不会自动导入）：`,
		...entries.map((entry, index) => intakeEntryLine(entry, index, timezone)),
		"",
		"调 memory_import(source=1) 看清单和代价——这一步只读，不写库。"
	].join("\n");
}
/**
* The preview: everything a person needs to say yes or no without opening a terminal.
*
* Three numbers have to be visible or the question is not answerable: what will
* actually land (after duplicates), what will be dropped and why, and what the
* optional alias step costs. The last one is the only part that spends money,
* so it is printed as a call count, not as "有成本".
* @param input - source entry, read result, plan and the alias estimate.
* @returns the preview text.
*/
function renderIntakePreview(input) {
	const { entry, read, plan, dropped, aliasLimit, timezone, budget } = input;
	const facts = plan.accept.length - plan.accept.filter((row) => row.kind === "instruction").length;
	const instructions = plan.accept.length - facts;
	const lines = [
		`【预览】${intakeLabel(entry)} · ${read.format === "sqlite" ? "SQLite" : read.format === "json" ? "JSON" : read.format === "jsonl" ? "JSONL" : "纯文本"} · ${humanSize(entry.bytes)} · 修改于 ${intakeStamp(entry.mtime, timezone)}`,
		`${entry.path}`,
		"",
		`读出来 ${read.total} 条，会导入 ${plan.accept.length} 条：`
	];
	if (plan.accept.length > 0) {
		lines.push(`  按类型：${intakeSpread(plan.accept, (row) => row.kind)}`);
		lines.push(`  按领域：${intakeSpread(plan.accept, (row) => row.domain)}`);
	}
	const skipped = [];
	if (read.note.length > 0) skipped.push(read.note);
	if (plan.duplicates > 0) skipped.push(`重复 ${plan.duplicates} 条（库里已经有一模一样的话）`);
	if (dropped.short > 0) skipped.push(`太短 ${dropped.short} 条`);
	if (dropped.secret > 0) skipped.push(`疑似密钥 ${dropped.secret} 条（不搬）`);
	if (dropped.long > 0) skipped.push(`${dropped.long} 条太长，只留了前 ${INTAKE_MAX_CHARS} 字`);
	if (dropped.retired > 0) skipped.push(`已收回的 ${dropped.retired} 条（在源里已经标为不再适用，不搬）`);
	if (read.total > INTAKE_MAX_ROWS) skipped.push(`超过 ${INTAKE_MAX_ROWS} 条的部分这次没读`);
	if (skipped.length > 0) lines.push(`  跳过：${skipped.join(" · ")}`);
	if (plan.downgraded > 0) lines.push(`  旧计划 ${plan.downgraded} 条：原文件里没有能用的日期，按事实存放，不会到期追问`);
	if (instructions > 0) lines.push(`  要求 ${instructions} 条会进常驻区（每轮都在眼前），其余进召回层`);
	if (facts > 0) {
		const calls = intakeCallEstimate(facts);
		const aliasesOff = aliasLimit <= 0;
		lines.push(aliasesOff ? "  检索别名：已在配置里关闭，导入后只能按原话搜到" : `  检索别名：这 ${facts} 条导进来时没有别名。补别名要调模型 ${calls} 次（每批 ${INTAKE_ALIAS_BATCH} 条），计入今天的调用预算${budget === null ? "" : `（今天还剩 ${budget} 次）`}。不补也能用，只是换个说法就搜不到。`);
	}
	lines.push("");
	lines.push(`确认要导入：memory_import(${input.selector}, confirm=true)${facts > 0 && aliasLimit > 0 ? `；想顺手补别名再加 aliases=true` : ""}`);
	lines.push(`不想要：memory_import(${input.selector}, dismiss=true)，以后不再提这件事`);
	lines.push("导入只读源文件，不删不改；它原来的插件卸载了也还在。");
	return lines.join("\n");
}
/** What actually landed. */
function renderIntakeDone(input) {
	const { entry, plan, written, aliasLimit } = input;
	const lines = [`【已导入】${intakeLabel(entry)} → ${plan.accept.length} 条`];
	if (plan.accept.length > 0) {
		lines.push(`  按类型：${intakeSpread(plan.accept, (row) => row.kind)}`);
		lines.push(`  按领域：${intakeSpread(plan.accept, (row) => row.domain)}`);
		if (written.preferences > 0) lines.push(`  ${written.preferences} 条要求进了常驻区，每轮都会出现在记忆里`);
	}
	if (plan.duplicates > 0) lines.push(`  跳过重复 ${plan.duplicates} 条`);
	lines.push(`  源文件没动：${entry.path}`);
	const facts = written.facts;
	if (facts > 0 && aliasLimit > 0) lines.push(`  这 ${facts} 条还没有别名：memory_import(aliases=true) 可以批量补（要调模型，${intakeCallEstimate(facts)} 次调用）`);
	return lines.join("\n");
}
/** The alias pass, reported as what it did rather than what it tried. */
function renderAliasReport(result) {
	if (!result.ok && result.reason === "disabled") return "检索别名在配置里关着（consolidation.aliasCount = 0），没有可补的。";
	if (!result.ok && result.reason === "no-model") return "这台机器上没有可用的模型路由，补不了别名。换回有模型的会话再试，或者等它重新整合时自己长出来。";
	const lines = [`【别名】补了 ${result.filled} 条 · 模型调用 ${result.calls} 次`];
	if (result.asked > 0) lines.push(`  这批看了 ${result.asked} 条`);
	if (result.reason === "budget") lines.push(`  今天的调用预算用完了，还剩 ${result.remaining} 条没补；明天再调一次会接着补`);
	else if (result.reason === "failed") lines.push(`  有一次调用失败，停下了；还剩 ${result.remaining} 条，再调一次会重试`);
	else if (result.remaining > 0) lines.push(`  还剩 ${result.remaining} 条（这次的上限到了），再调一次接着补`);
	if (result.filled === 0 && result.reason === "done") lines.push("  模型没给出可用的别名——它可能觉得这些句子已经够直白。这不影响记忆本身。");
	return lines.join("\n");
}

//#endregion
//#region src/host.ts
/** Failure text that consolidation can catch without parsing. */
var LlmUnavailableError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "LlmUnavailableError";
	}
};
function preferenceOf(config) {
	return {
		provider: config.consolidation.provider.length > 0 ? config.consolidation.provider : null,
		model: config.consolidation.model.length > 0 ? config.consolidation.model : null
	};
}
/**
* Build the bridge over the host context.
* @param ctx - plugin context; `llm` is read lazily through `ctx.get`.
* @param config - plugin config, for the configured fallback route.
* @returns a bridge whose `complete` never resolves without text.
*/
function createLlmBridge(ctx, config) {
	const configured = preferenceOf(config);
	let discovered;
	let discovering;
	const service = () => ctx.get("llm", false);
	const discover = async () => {
		const llm = service();
		if (llm === void 0) return void 0;
		const providers = llm.listProviders();
		for (const provider of providers) try {
			const first = (await llm.listModels(provider.id))[0];
			if (first !== void 0) return {
				provider: provider.id,
				model: first.id
			};
		} catch {
			continue;
		}
	};
	const resolve = async (preference) => {
		const provider = preference?.provider ?? configured.provider ?? void 0;
		const model = preference?.model ?? configured.model ?? void 0;
		if (provider !== void 0 && model !== void 0 && provider.length > 0 && model.length > 0) return {
			provider,
			model
		};
		if (discovered !== void 0) return discovered;
		discovering ??= discover().finally(() => {
			discovering = void 0;
		});
		discovered = await discovering;
		if (discovered !== void 0) return discovered;
		if (provider !== void 0 && provider.length > 0) {
			const llm = service();
			if (llm === void 0) return void 0;
			try {
				const first = (await llm.listModels(provider))[0];
				if (first !== void 0) return {
					provider,
					model: first.id
				};
			} catch {
				return;
			}
		}
	};
	const complete = async (request) => {
		const llm = service();
		if (llm === void 0) throw new LlmUnavailableError("memory-loom: no llm service is registered");
		const route = await resolve({
			provider: request.provider,
			model: request.model
		});
		if (route === void 0) throw new LlmUnavailableError("memory-loom: no model route is available");
		const stream = llm.stream({
			provider: route.provider,
			model: route.model,
			system: request.system,
			messages: [{
				role: "user",
				content: [{
					type: "text",
					text: request.prompt
				}]
			}],
			maxTokens: request.maxTokens,
			...request.signal === void 0 ? {} : { signal: request.signal }
		});
		let text = "";
		let failure = null;
		for await (const chunk of stream) if (chunk.type === "text-delta") text += chunk.text;
		else if (chunk.type === "finish") {
			if (chunk.reason.kind === "error") failure = String(chunk.reason.failure.message ?? "model error");
			else if (chunk.reason.kind === "aborted") failure = "model call aborted";
		}
		if (failure !== null) throw new LlmUnavailableError(`memory-loom: ${failure}`);
		if (text.trim().length === 0) throw new LlmUnavailableError("memory-loom: the model returned no text");
		return {
			text,
			provider: route.provider,
			model: route.model
		};
	};
	return {
		complete,
		available: () => service() !== void 0,
		resolve
	};
}

//#endregion
//#region src/tools.ts
const KIND_CHOICES = [
	"fact",
	"preference",
	"instruction",
	"plan",
	"relationship"
];
const PERSONA_ACTIONS = [
	"view",
	"update",
	"lock",
	"unlock"
];
const IDENTITY_ACTIONS = [
	"show",
	"list",
	"claim",
	"approve",
	"reject",
	"erase",
	"export"
];
function sessionOf(exec) {
	const agent = exec.agent;
	if (agent === void 0) throw new Error("memory-loom: this tool needs an agent session");
	return String(agent.id);
}
function actorOf(deps, exec) {
	const sessionId = sessionOf(exec);
	return {
		sessionId,
		actor: deps.engine.identityOf(sessionId)
	};
}
function requireMaster(actor) {
	if (actor.role !== "master") throw new Error("memory-loom: 只有主人可以做这个操作");
}
function dateOf(deps, sessionId, at) {
	return dayKey(at, deps.engine.timezoneOf(sessionId));
}
/**
* Rewrite the tool names inside a parameter spec's descriptions.
* @param parameters - the tool's parameter map.
* @param prefix - the configured prefix.
* @returns a copy with renamed descriptions.
*/
function renameParameters(parameters, prefix) {
	if (prefix === DEFAULT_TOOL_PREFIX) return parameters;
	const out = {};
	for (const [key, spec] of Object.entries(parameters)) out[key] = typeof spec.description === "string" ? {
		...spec,
		description: renameToolNames(spec.description, prefix)
	} : spec;
	return out;
}
/**
* One text-returning tool. Everything the model reads about a tool passes
* through here — its name, its description, its parameter docs, and its return
* value — so this is the single place a renamed prefix has to be applied.
* @param options - name, description, parameters, run, and optional prefix.
* @returns a ready tool definition.
*/
function textTool(options) {
	const prefix = options.prefix ?? DEFAULT_TOOL_PREFIX;
	const rename = (text) => renameToolNames(text, prefix);
	return defineTool({
		name: rename(options.name),
		description: rename(options.description),
		parameters: renameParameters(options.parameters, prefix),
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args, exec) => rename(String(await options.run(args, exec)))
	});
}
function personaLine(zone) {
	const flags = [zone.locked ? "已锁定" : null, `可编辑: ${zone.editableBy}`].filter((item) => item !== null).join("，");
	return `- ${zone.zone}（${flags}）：${zone.text}`;
}
/**
* Build the sixteen definitions. They are pure factories over the engine; the
* caller registers them on the plugin's context.
* @param deps - engine and config.
* @returns ready tool definitions.
*/
function buildTools(deps) {
	const { engine, config } = deps;
	/**
	* Local factory: every tool inherits the configured prefix, so a deployment
	* that renamed the tools for coexistence does not have to pass it 15 times.
	* The names below stay written as `memory_*` — that is the default spelling
	* and the one the suffixes in TOOL_SUFFIXES are derived from.
	*/
	const tool = (options) => textTool({
		prefix: config.toolPrefix,
		...options
	});
	return [
		tool({
			name: "memory_search",
			description: "在长期记忆里搜索关于当前用户的事实、共同经历与长期规矩（用户要求一直遵守的偏好）。每条结果带一个编号（#E12 共同经历 / #F7 事实 / #P3 长期规矩），可以直接交给 memory_expand 取回原文。用户问「我有什么规矩 / 忌口 / 一直要我怎么做」这类问题时用这个工具，不要只凭记忆块里那几行回答。可选的 identity 只能由主人用于查询他人（受隐私开关限制，且不返回对方的长期规矩）。",
			parameters: {
				query: {
					type: "string",
					description: "要搜索的关键词或一句话",
					required: true
				},
				identity: {
					type: "string",
					description: "仅主人可用：目标用户 id"
				},
				limit: {
					type: "integer",
					description: "返回条数，默认 10，最多 50"
				}
			},
			run: (args, exec) => {
				const { sessionId, actor } = actorOf(deps, exec);
				const target = typeof args.identity === "string" && args.identity.trim().length > 0 ? args.identity.trim() : void 0;
				if (target !== void 0 && target !== actor.id) {
					requireMaster(actor);
					if (!config.privacy.masterCrossIdentity) throw new Error("memory-loom: 跨用户查询已在配置中关闭");
				}
				const hits = engine.searchFor({
					sessionId,
					actor,
					query: String(args.query),
					identityId: target,
					limit: args.limit
				});
				if (hits.length === 0) return "没有找到相关记忆。";
				const now = engine.now();
				const timezone = engine.timezoneOf(sessionId);
				const lines = hits.map((hit, index) => {
					const stale = hit.status === "pending_delete" ? "（用户要求忘记，即将删除）" : hit.status === "superseded" ? "（已被更新）" : "";
					/*
					* 收尾过的计划在搜索结果里也要说清楚。块里靠「计划区不含已收尾」
					* 这件事避免误解，搜索结果没有那个分区，只能靠这一句：
					* 「用户打算周五去看房」和「用户打算周五去看房（已取消）」是两件事，
					* 前者会让模型问「那你到底去没去」。
					*/
					const ended = hit.planEnd === null || hit.planEnd === void 0 ? "" : `（${PLAN_ENDINGS[hit.planEnd]?.zh ?? String(hit.planEnd)}）`;
					// `events.id`, `facts.id` and `preferences.id` are independent
					// counters, so a bare number is ambiguous: 1 may be all three of
					// E1, F1 and P1. Prefix it here so the ref can be handed to
					// `memory_expand` — and to `memory_forget`, which routes on the
					// letter — without guessing.
					const ref = `${hit.kind === "event" ? "E" : hit.kind === "preference" ? "P" : "F"}${hit.id}`;
					// Only events carry valence/arousal, so the tone hint is appended
					// there and facts are printed exactly as stored — except for the
					// relative time words, which are annotated with the date they
					// pointed at when the line was written (see `anchorRelativeTime`).
					const stored = hit.kind === "event" ? withTone(hit.text, hit, engine.config, config.locale) : hit.text;
					const text = anchorRelativeTime(stored, hit.createdAt, timezone, now, config.locale);
					// A preference has no domain (it is a standing rule, not a topic), so
					// the column is dropped rather than printed as "null".
					const domain = typeof hit.domain === "string" && hit.domain.length > 0 ? ` · ${hit.domain}` : "";
					return `${index + 1}. [${dateOf(deps, sessionId, hit.createdAt)} · ${hit.kind}${domain}] ${text}${ended}${stale}  (#${ref})`;
				});
				return `找到 ${hits.length} 条记忆：\n${lines.join("\n")}`;
			}
		}),
		tool({
			name: "memory_write",
			description: "把一件值得长期记住的事写进记忆。instructions 类会进入长期偏好区。重复内容会自动合并，与旧事实冲突时旧事实会被标记为已被取代。",
			parameters: {
				text: {
					type: "string",
					description: "要记住的内容，一句话，尽量包含人物、时间、结果",
					required: true
				},
				kind: {
					type: "string",
					enum: KIND_CHOICES,
					description: "记忆类型，默认 fact"
				},
				pinned: {
					type: "boolean",
					description: "置顶（几乎不会被遗忘）"
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "标签"
				},
				aliases: {
					type: "array",
					items: { type: "string" },
					description: "可选：用户下次可能用来找这条记忆的 2-3 个说法（口语、换说法、带具体对象名，每个 ≤6 字）。不要写「工作」「心情」这类泛词"
				}
			},
			run: (args, exec) => {
				const { actor, sessionId } = actorOf(deps, exec);
				const result = engine.writeFact({
					identity: actor,
					sessionId,
					text: String(args.text),
					kind: args.kind,
					pinned: args.pinned,
					tags: Array.isArray(args.tags) ? args.tags : void 0,
					aliases: Array.isArray(args.aliases) ? args.aliases : void 0
				});
				if (!result.created && result.action === "rejected") return `没有记住：${result.reason ?? "内容不合格"}`;
				if (result.action === "merged") return `已合并到既有记忆 #${String(result.id)}。`;
				if (result.action === "preference") return `已记入长期偏好 #${String(result.id)}。`;
				if (result.action === "superseded") return `已记住 #${String(result.id)}，并标记旧记忆为已被取代。`;
				return `已记住 #${String(result.id)}。`;
			}
		}),
		tool({
			name: "memory_forget",
			description: "忘记一条记忆。默认是软删除（可恢复），permanent=true 时立即彻底删除。事实用 id（搜索结果里的 #F7 就写 id=7），长期规矩用 ref（#P3 就写 ref=\"P3\"）——两张表的编号各自从 1 开始，拿规矩的编号去填 id 会删掉一条毫不相干的事实。",
			parameters: {
				id: {
					type: "integer",
					description: "要忘记的事实的编号：搜索结果里 #F7 的 7"
				},
				ref: {
					type: "string",
					description: "带类型字母的编号：长期规矩写 P3（写 F7 等同 id=7）。给了 ref 就不用 id"
				},
				permanent: {
					type: "boolean",
					description: "立即彻底删除，默认 false"
				}
			},
			run: (args, exec) => {
				const { actor } = actorOf(deps, exec);
				/*
				* One handle instead of two. A bare number means a fact (the shape
				* every earlier version of this tool accepted, and what `#F7` still
				* reduces to), anything else is read as a typed ref.
				*
				* `id` is declared as an integer, so the host rejects `id="P3"` before
				* this code runs (it answers "id must be an integer" and the model
				* retries with `ref`) — the `String(args.id)` below is only for hosts
				* that do not validate. `ref="12"` has no such guard, which is why the
				* normalisation happens after the merge rather than inside the `id`
				* branch: that mistake is ours to absorb, and it must land on F12
				* instead of costing a retry.
				*/
				let handle = String(args.ref ?? "").trim();
				if (handle.length === 0 && args.id !== void 0 && args.id !== null) handle = String(args.id).trim();
				if (handle.length === 0) return "没给编号：事实用 id=7，长期规矩用 ref=\"P3\"。";
				if (/^\d+$/u.test(handle)) handle = `F${handle}`;
				const target = parseRef(handle);
				if (target === null) return `编号看不懂：${handle}。事实用 id=7，长期规矩用 ref="P3"。`;
				if (target.kind === "tail" || target.kind === "doc") return `${normalizeRef(target)} 不是一条可以忘记的记忆：T 是还没整理的对话，D 是整理稿。`;
				if (target.kind === "event") return `E${String(target.id)} 是一段共同经历，删它会连带动里面的对话和事实。要清掉整段请用 memory_identity 的 erase，或先忘记它关联的事实。`;
				if (target.kind === "preference") {
					const retired = engine.forgetPreference({
						identity: actor,
						id: target.id,
						permanent: args.permanent === true
					});
					if (!retired.forgotten) return `没有忘记 P${String(target.id)}：不存在，或你没有权限。`;
					/*
					* Name the sentence, not just the number. A wrong id is the one
					* failure mode this tool cannot detect on its own — the row exists
					* and the write succeeds — so the reply has to make the mistake
					* visible in the transcript.
					*/
					return args.permanent === true ? `已彻底删除长期规矩 P${String(target.id)}：「${clip(retired.text, 40)}」。` : `长期规矩 P${String(target.id)}「${clip(retired.text, 40)}」已移出，以后不再当作要求（行还在，不进常驻区也不再被搜到）。`;
				}
				const result = engine.forget({
					identity: actor,
					id: target.id,
					permanent: args.permanent
				});
				if (!result.forgotten) return `没有删除 #${String(target.id)}：不存在，或你没有权限。`;
				return args.permanent === true ? `已彻底删除 #${String(target.id)}：「${clip(result.fact.text, 40)}」。` : `已标记删除 #${String(target.id)}「${clip(result.fact.text, 40)}」，${config.roles.pendingDeleteDays} 天后彻底清除。`;
			}
		}),
		tool({
			name: "memory_settle",
			description: "落实一条「时间待确认」：记忆块里某行后面写着「时间待确认」时，先问用户，等用户明确表态后再调用。accept=true 改用新时间，accept=false 保留原来记的时间。不要自己替用户决定。",
			parameters: {
				id: {
					type: "integer",
					description: "那条记忆的编号（块里同一条计划后面写着的 memory_settle(id=…)）",
					required: true
				},
				accept: {
					type: "boolean",
					description: "true = 用新时间；false = 保留原时间",
					required: true
				}
			},
			run: (args, exec) => {
				const { actor } = actorOf(deps, exec);
				const result = engine.settle({
					identity: actor,
					id: Number(args.id),
					accept: args.accept === true
				});
				if (result.settled) return result.accepted === true ? `已把 #${String(args.id)} 的时间改成新时间。` : `#${String(args.id)} 保留原来的时间。`;
				/*
				* 报库里那个结局，不要按「办成 / 没办成」二选一。取消也走这条路，
				* 而对一条取消的计划说「没办成」正是这次要分开的那两件事。
				*/
				if (result.reason === "resolved") return `#${String(args.id)} 已经有结果了（${PLAN_ENDINGS[result.outcome]?.said ?? String(result.outcome)}），不用再确认时间；要重新做就记成一条新计划。`;
				if (result.reason === "none") return `#${String(args.id)} 没有待确认的时间。`;
				if (result.reason === "denied") return `没有权限修改 #${String(args.id)}。`;
				return `没有找到 #${String(args.id)}。`;
			}
		}),
		tool({
			name: "memory_resolve",
			description: "给一条计划收尾。用户说出结果就调，不用等日期。outcome 三选一：done = 办成了（去了、交了、弄完了）；missed = 到日子没办成（没去、没弄完）；cancelled = 不做了（不去了、算了、取消了）—— 取消是他的决定，不是失败，别记成 missed。两种时机：①记忆块里某行写着「后来成了吗」——先问用户，等他明确回答；②用户自己提到结果，哪怕日期还没到，也当场收尾，不必等到期。三种结果都会写一条新事实，计划原文不动，收尾后它不再出现在计划区。只是改了个日子（「改到下周了」）不是结果，不要调它。不要替他回答，也不要因为没提到就默认办成；只收他自己说出结果的事。",
			parameters: {
				id: {
					type: "integer",
					description: "计划编号（块里那行写着的 memory_resolve(id=…)）",
					required: true
				},
				outcome: {
					type: "string",
					enum: ["done", "missed", "cancelled"],
					description: "结局：done = 办成了；missed = 没办成；cancelled = 他不做了",
					required: true
				},
				note: {
					type: "string",
					description: "可选：用户原话里的补充，比如「那套没看上」「改天再说」"
				}
			},
			run: (args, exec) => {
				const { sessionId, actor } = actorOf(deps, exec);
				const result = engine.resolve({
					identity: actor,
					sessionId,
					id: Number(args.id),
					outcome: args.outcome,
					note: typeof args.note === "string" ? args.note : void 0
				});
				if (result.resolved) return `已记下：#${String(args.id)} ${PLAN_ENDINGS[result.outcome].said}（新事实 #${String(result.factId)}）。`;
				if (result.reason === "not-plan") return `#${String(args.id)} 不是计划，不用这样收尾。`;
				if (result.reason === "bad-outcome") return `结局只能是 done、missed、cancelled 之一；「改到下周了」不是结局，那是改期。`;
				if (result.reason === "already") return `#${String(args.id)} 之前已经收过尾了（${PLAN_ENDINGS[result.outcome]?.said ?? String(result.outcome)}）。`;
				if (result.reason === "denied") return `没有权限修改 #${String(args.id)}。`;
				return `没有找到 #${String(args.id)}。`;
			}
		}),
		tool({
			name: "memory_profile",
			description: "查看当前记忆概览：人设卡、自我叙述、对这个人的印象和各类记忆数量。",
			parameters: {},
			run: (_args, exec) => {
				const { sessionId, actor } = actorOf(deps, exec);
				const data = engine.profile(actor.id);
				const rows = [
					`用户：${data.name}（${data.role}）`,
					`事实 ${data.facts} 条 · 事件 ${data.events} 段 · 日记 ${data.diary} 篇`,
					"",
					data.persona.length > 0 ? data.persona : "（人设卡为空）"
				];
				if (data.narrative !== null) rows.push("", `【自我叙述】\n${clip(data.narrative, 600)}`);
				if (data.impression !== null) rows.push("", `【我对你的印象】\n${clip(data.impression, 400)}`);
				const mirror = engine.diaryMirror;
				if (mirror.root !== null) rows.push("", `日记目录：${mirror.root}（每天一个 .md，可直接用文件管理器打开）`);
				rows.push("", `（时区 ${engine.timezoneOf(sessionId) ?? "本机"}，今天 ${formatDateTime(engine.now(), engine.timezoneOf(sessionId))}）`);
				return rows.join("\n");
			}
		}),
		tool({
			name: "memory_persona",
			description: "查看或修改人设卡。只有主人可以修改；锁定区需要 confirm=true 才能改。",
			parameters: {
				action: {
					type: "string",
					enum: PERSONA_ACTIONS,
					description: "view（默认）/ update / lock / unlock",
					required: true
				},
				zone: {
					type: "string",
					description: "分区名：identity / voice / values / boundaries / relationship，update 时必填"
				},
				text: {
					type: "string",
					description: "update 时的新内容"
				},
				confirm: {
					type: "boolean",
					description: "修改或解锁锁定区时的二次确认"
				},
				overlay: {
					type: "boolean",
					description: "只对当前用户生效的覆写，而不是全局面板"
				}
			},
			run: (args, exec) => {
				const { actor } = actorOf(deps, exec);
				const action = args.action ?? "view";
				if (action === "view") {
					const zones = engine.store.personaZones();
					if (zones.length === 0) return "人设卡为空。";
					return `人设卡：\n${zones.map(personaLine).join("\n")}`;
				}
				requireMaster(actor);
				const zone = typeof args.zone === "string" ? args.zone.trim() : "";
				if (zone.length === 0) throw new Error("memory-loom: 需要指定 zone");
				if (action === "lock" || action === "unlock") {
					const result$1 = engine.lockPersona(zone, action === "lock", args.confirm === true);
					return result$1.ok ? `已${action === "lock" ? "锁定" : "解锁"} ${zone}。` : `没有修改：${result$1.reason ?? "未知原因"}`;
				}
				const text = typeof args.text === "string" ? args.text : "";
				if (text.trim().length === 0) throw new Error("memory-loom: update 需要 text");
				const result = engine.writePersona({
					zone,
					text,
					source: "master",
					identityId: actor.id,
					overlay: args.overlay === true,
					confirmUnlock: args.confirm === true
				});
				if (!result.ok) return `没有修改：${result.reason ?? "未知原因"}`;
				return `已更新 ${zone}。`;
			}
		}),
		tool({
			name: "memory_identity",
			description: "身份管理：查看当前身份（show）、导出记忆（export）、列出所有身份、认领身份、审批或拒绝认领、按用户要求清除记忆。claim 由需要被认出的那个人自己发起（主人不需要认领）；list/approve/reject/erase 只有主人可用；export 只能导出自己，主人可导出任何人。",
			parameters: {
				action: {
					type: "string",
					enum: IDENTITY_ACTIONS,
					description: "show / list / claim / approve / reject / erase",
					required: true
				},
				name: {
					type: "string",
					description: "claim 时的自称；approve/reject 时可作为备注"
				},
				evidence: {
					type: "string",
					description: "claim 时的自证材料"
				},
				claimId: {
					type: "integer",
					description: "approve / reject 的认领编号"
				},
				identityId: {
					type: "string",
					description: "erase 的目标用户 id"
				},
				keepFacts: {
					type: "boolean",
					description: "erase 时保留事实（只删原始对话）"
				}
			},
			run: (args, exec) => {
				const { sessionId, actor } = actorOf(deps, exec);
				const action = args.action ?? "show";
				if (action === "show") return [
					`身份：${actor.name}（${actor.role}，${actor.status}）`,
					`id：${actor.id}`,
					`会话：${sessionId}`,
					`时区：${engine.timezoneOf(sessionId) ?? "本机"}`
				].join("\n");
				if (action === "export") {
					const targetId$1 = typeof args.identityId === "string" && args.identityId.trim().length > 0 ? args.identityId.trim() : actor.id;
					if (targetId$1 !== actor.id && actor.role !== "master") throw new Error("memory-loom: 只能导出自己的记忆");
					return clip(JSON.stringify(engine.exportData(targetId$1), null, 2), 2e4);
				}
				/*
				* Claim sits before `requireMaster` on purpose. A claim is what the
				* person who wants to be recognised says about themselves; the master
				* is the one who reviews it, so requiring the master to be the claimant
				* made the whole flow unreachable — and worse, `reviewClaim` promotes
				* the claimant to `friend`, so a master who claimed would approve
				* themselves out of every permission.
				*/
				if (action === "claim") {
					if (actor.role === "master") throw new Error("memory-loom: 主人身份不需要认领");
					const name$1 = typeof args.name === "string" ? args.name.trim() : "";
					if (name$1.length === 0) throw new Error("memory-loom: claim 需要 name");
					const id = claimIdentity({
						store: engine.store,
						now: engine.now(),
						sessionId,
						claimant: actor,
						displayName: name$1,
						evidence: typeof args.evidence === "string" ? args.evidence : ""
					});
					return `已提交认领 #${String(id)}，等待主人确认。`;
				}
				requireMaster(actor);
				if (action === "list") {
					const rows = engine.store.listIdentities().map((item) => `- ${item.name}（${item.role}，${item.status}） ${item.id}`);
					return rows.length === 0 ? "没有任何身份。" : `身份列表：\n${rows.join("\n")}`;
				}
				if (action === "approve" || action === "reject") {
					const claimId = Number(args.claimId);
					if (!Number.isInteger(claimId)) throw new Error("memory-loom: approve/reject 需要 claimId");
					const result$1 = reviewClaim({
						store: engine.store,
						now: engine.now(),
						claimId,
						approve: action === "approve",
						note: typeof args.name === "string" ? args.name : void 0
					});
					return result$1.status === "approved" ? `已通过认领 #${String(claimId)}${result$1.identityId === void 0 ? "" : `（身份 ${result$1.identityId}）`}。` : `已拒绝认领 #${String(claimId)}。`;
				}
				const targetId = typeof args.identityId === "string" ? args.identityId.trim() : "";
				if (targetId.length === 0) throw new Error("memory-loom: erase 需要 identityId");
				const target = engine.store.getIdentity(targetId);
				if (target === void 0) throw new Error(`memory-loom: 没有身份 ${targetId}`);
				const result = engine.erase({
					identity: target,
					actor: actor.id,
					keepFacts: args.keepFacts === true
				});
				if (result.mode === "immediate") return `已立即清除 ${target.name}：原始对话 ${result.l0} 条，事实 ${result.facts} 条。`;
				return `已为 ${target.name} 安排清除：${config.roles.pendingDeleteDays} 天内可撤销，到期后彻底删除 ${result.facts} 条事实及其对话。`;
			}
		}),
		tool({
			name: "memory_expand",
			description: `按索引里的编号取回正文：E 开头是共同经历（原始对话），F 开头是一条事实的上下文，P 开头是一条长期规矩的原文，D 开头是一篇整理好的叙事，T 是最近还没整理的对话。一次最多返回约 ${config.index.expandBudgetTokens} token，长文会自动分页。`,
			parameters: {
				ref: {
					type: "string",
					description: "索引里的编号，例如 E37、F12、P3、D3",
					required: true
				},
				offset: {
					type: "integer",
					description: "从第几个字开始读，默认 0；接续上次的返回值"
				}
			},
			run: (args, exec) => {
				const { sessionId } = actorOf(deps, exec);
				const identityId = deps.engine.identityOf(sessionId).id;
				const ref = String(args.ref ?? "").trim().toUpperCase();
				const offset = Math.max(0, Number(args.offset ?? 0) || 0);
				const found = deps.index.body(identityId, ref);
				if (!found.ok) return `没有取到：${found.reason}`;
				const sliced = sliceByTokens(found.text, offset, deps.config.index.expandBudgetTokens);
				if (sliced.piece.length === 0) return `第 ${offset + 1} 字之后没有内容了（全文 ${found.chars} 字）。`;
				if (offset === 0) deps.index.noteAccess(identityId, ref);
				return expandFooter(deps.config, ref, offset, { ...sliced, label: found.label, chars: found.chars });
			}
		}),
		tool({
			name: "memory_pack",
			description: "把一段叙述整理后单独存下来，并挂到某个钩子上（ref 可选）。之后 memory_expand 优先返回这份整理版，而不是原始对话。只在内容值得长期反复取回时使用——它会占一次写入，但不占上下文。",
			parameters: {
				title: {
					type: "string",
					description: "15 字以内的标题，会出现在索引行里",
					required: true
				},
				text: {
					type: "string",
					description: "整理后的正文：来龙去脉、当时的想法、结论",
					required: true
				},
				ref: {
					type: "string",
					description: "挂到哪个钩子上，例如 E37；留空则生成新的 D 编号"
				}
			},
			run: (args, exec) => {
				const { sessionId } = actorOf(deps, exec);
				const identityId = deps.engine.identityOf(sessionId).id;
				const packed = deps.index.pack({
					identityId,
					title: String(args.title ?? ""),
					text: String(args.text ?? ""),
					ref: args.ref
				});
				if (packed.droppedTail) return `已存下「${clip(String(args.title), 20)}」，${packed.chars} 字（约 ${packed.tokens} token），编号 D${packed.id}。T 是滚动的未整理区间，挂不住固定正文，所以单独生成了一篇。`;
				if (packed.missingRef !== null) return `已存下「${clip(String(args.title), 20)}」，${packed.chars} 字（约 ${packed.tokens} token），编号 D${packed.id}。索引里没有 ${packed.missingRef}（编号记错了），所以没有挂上去；正文仍然可用 memory_expand(ref="D${packed.id}") 取回。`;
				const where = packed.linked ? `已挂到 ${String(args.ref).toUpperCase()}` : `新编号 D${packed.id}`;
				return `已存下「${clip(String(args.title), 20)}」，${packed.chars} 字（约 ${packed.tokens} token），${where}。正文不进上下文，需要时用 memory_expand 取。`;
			}
		}),
		tool({
			name: "memory_index",
			description: "查看或调整记忆索引：view 看当前驻留的钩子，search 在全部钩子里找，promote 把一条提到索引顶部，rebuild 重建，gc 清掉「钩子已被删除」的孤儿正文。",
			parameters: {
				action: {
					type: "string",
					enum: ["view", "search", "promote", "rebuild", "gc"],
					description: "默认 view",
					required: true
				},
				query: {
					type: "string",
					description: "search 时的关键词"
				},
				ref: {
					type: "string",
					description: "promote 时的编号"
				}
			},
			run: (args, exec) => {
				const { sessionId } = actorOf(deps, exec);
				const identityId = deps.engine.identityOf(sessionId).id;
				const index = deps.index;
				if (args.action === "gc") {
					const removed = index.gc(identityId);
					if (removed.length === 0) return "没有需要清理的孤儿正文。";
					return `已清掉 ${removed.length} 篇挂钩已失效的正文：${removed.map((row) => `${row.ref}(${clip(row.title, 12)})`).join("、")}`;
				}
				if (args.action === "rebuild") {
					const report = index.rebuild(identityId);
					return `已重建：驻留 ${report.resident} 条 / 候选 ${report.candidates} 条，占 ${report.tokens} token。`;
				}
				if (args.action === "promote") {
					const ref = String(args.ref ?? "").trim().toUpperCase();
					const row = index.db.prepare("SELECT ref FROM loom_hooks WHERE identity_id = ? AND ref = ?").get(identityId, ref);
					if (row === void 0) return `索引里没有 ${ref}。`;
					index.db.prepare("UPDATE loom_hooks SET score = 9, cold_until = NULL WHERE identity_id = ? AND ref = ?").run(identityId, ref);
					index.rebuild(identityId);
					return `已把 ${ref} 提到顶部。`;
				}
				if (args.action === "search") {
					const query = String(args.query ?? "").trim();
					if (query.length === 0) return "search 需要 query。";
					// Escape LIKE wildcards so a literal `%` or `_` in the query
					// matches itself instead of widening the match.
					const pattern = `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
					const rows = index.db.prepare(`
            SELECT ref, label, resident, score FROM loom_hooks
            WHERE identity_id = ? AND label LIKE ? ESCAPE '\\'
            ORDER BY score DESC LIMIT 20
          `).all(identityId, pattern);
					if (rows.length === 0) return `钩子里没有和「${query}」相关的。`;
					return rows.map((row) => `${row.resident === 1 ? "·" : " "} ${row.ref} ${row.label}`).join("\n");
				}
				if (index.db.prepare("SELECT 1 AS hit FROM loom_hooks WHERE identity_id = ? AND resident = 1 LIMIT 1").get(identityId) === void 0) index.rebuild(identityId);
				const text = index.render(identityId);
				const total = index.db.prepare("SELECT COUNT(*) AS n FROM loom_hooks WHERE identity_id = ?").get(identityId).n;
				if (text.length === 0) return "索引为空。";
				return `${text}\n—\n驻留 ${text.split("\n").length - 1} 条，候选池 ${total} 条。`;
			}
		}),
		tool({
			name: "memory_doctor",
			description: "记忆自检：逐项检查库连接、库文件、WAL、journal 模式、完整性、各表数量、最近一次召回、prompt 三块的连续失败，指出记忆读不出来的具体位置。只读，不改任何数据。",
			parameters: {},
			run: (_args, exec) => {
				let sessionId = "";
				try {
					sessionId = sessionOf(exec);
				} catch {}
				return diagnose(deps, sessionId);
			}
		}),
		tool({
			name: "memory_demo",
			description: "三十秒演示：在一个一次性的内存库里走完「你说要做某事 → 到日子 → 它回来问 → 你答了 → 记成事实」，全程不读也不改真实记忆。用户问「这东西到底能干什么」「它真的会回来问我吗」时，先跑一遍给他看，比解释一段机制有用。",
			parameters: {},
			run: () => runDemo(deps)
		}),
		tool({
			name: "memory_import",
			description: "把别的记忆插件留下的记忆搬进本插件。用法四种：①不带参数——列出磁盘上检测到的别人的记忆文件；②带 source 或 path、不带 confirm——预览，说明会导入多少条、什么类型、哪些重复、补别名要调多少次模型；③confirm=true——真的写进来（偏好和要求进常驻区，事实进召回层，旧计划按事实存放、不会到期追问，原始日期保留）；④aliases=true——只补别名，给库里所有缺别名的事实批量重建（要调模型，有成本，计入今天的调用预算）。用户没明确说要导入时不要 confirm=true；用户说不用就 dismiss=true，以后不再提。导入只读源文件，不删不改。",
			parameters: {
				source: {
					type: "integer",
					description: "第几份（不带参数调用时返回的编号）。和 path 二选一"
				},
				path: {
					type: "string",
					description: "直接给文件路径，用户把记忆文件拖进聊天窗口时用这个。和 source 二选一"
				},
				confirm: {
					type: "boolean",
					description: "true = 真的导入。只能在这个用户明确同意之后传"
				},
				dismiss: {
					type: "boolean",
					description: "true = 用户不要这份记忆，记下来，以后不再提。不导入、不删文件"
				},
				aliases: {
					type: "boolean",
					description: "补检索别名（要调模型）。单独用是只补别名；和 confirm 一起用是导入完顺手补"
				},
				limit: {
					type: "integer",
					description: "补别名时这次最多看多少条，默认 60，最多 400"
				}
			},
			run: async (args, exec) => {
				const { sessionId, actor } = actorOf(deps, exec);
				requireMaster(actor);
				const now = engine.now();
				const timezone = engine.timezoneOf(sessionId);
				const hasSelector = args.source !== void 0 || (typeof args.path === "string" && args.path.trim().length > 0);
				/*
				* The periodic scan is throttled to six hours, which is right for a
				* block rendered every turn and wrong for a user who just asked 「还有吗」.
				* A bare call is an explicit request, so it rescans; a call about one
				* source does not, because the entry is already in hand.
				*/
				const pending = refreshIntake(config, engine.store, {
					now,
					force: !hasSelector
				});
				const selector = args.source !== void 0 ? `source=${Number(args.source)}` : `path="${String(args.path ?? "").trim()}"`;
				if (args.aliases === true && !hasSelector) return renderAliasReport(await engine.rebuildAliases({
					identityId: actor.id,
					sessionId,
					limit: args.limit,
					route: routeOf(engine, sessionId)
				}));
				if (!hasSelector) return renderIntakeList(pending, timezone);
				let entry;
				if (typeof args.path === "string" && args.path.trim().length > 0) {
					const path = resolve(args.path.trim());
					let stat;
					try {
						stat = statSync(path);
					} catch {
						return `读不到这个文件：${path}\n确认路径对不对；也可以把文件拖进聊天窗口再试。`;
					}
					if (!stat.isFile()) return `${path} 不是文件。`;
					entry = {
						path,
						plugin: intakePluginFor(path),
						format: intakeFormatOf(path),
						bytes: stat.size,
						mtime: Math.round(stat.mtimeMs),
						rows: null,
						note: ""
					};
				} else {
					const index = Number(args.source);
					if (!Number.isInteger(index) || index < 1 || index > pending.length) return `没有第 ${String(args.source)} 份。不带参数调一次 memory_import 可以看到现在的清单。`;
					entry = pending[index - 1];
				}
				if (args.dismiss === true) {
					const dismissed = intakeMeta(engine.store, "intake.dismissed", []);
					const list = Array.isArray(dismissed) ? [...new Set([...dismissed, entry.path])] : [entry.path];
					engine.store.setMeta("intake.dismissed", JSON.stringify(list));
					engine.store.audit(actor.id, "intake.dismiss", "file", entry.path, {}, now);
					return `记下了：不再提 ${intakeLabel(entry)}。\n文件没动，还在 ${entry.path}；哪天想导，memory_import(path="${entry.path}") 随时可以。`;
				}
				const read = readIntakeSource(entry, INTAKE_MAX_ROWS);
				if (!read.ok) return `这份现在读不出来：${intakeLabel(entry)}\n${read.note.length > 0 ? read.note : "原因不明"}\n\n文件没动，也不会被删。对方插件要是还开着，它可能正锁着这个文件——关掉再试一次；不导也不影响任何事。`;
				if (read.total === 0) {
					recordImported(engine, entry, {
						accept: [],
						duplicates: 0
					}, now);
					return `这份里没读出记忆：${intakeLabel(entry)}\n${read.note.length > 0 ? read.note : "文件在，但没有一行像记忆（可能是空的，或者格式不认）。以后不再提它。"}`;
				}
				const normalized = normalizeIntakeRows(read.records, entry.plugin, now);
				const plan = planIntake(engine.store, actor.id, normalized.rows);
				const aliasLimit = config.consolidation.aliasCount;
				if (args.confirm !== true) return renderIntakePreview({
					entry,
					read,
					plan,
					dropped: normalized.dropped,
					aliasLimit,
					timezone,
					budget: config.consolidation.enabled ? Math.max(0, config.consolidation.dailyLlmCalls - engine.dailyCalls(actor.id)) : null,
					selector
				});
				if (plan.accept.length === 0) {
					recordImported(engine, entry, plan, now);
					const why = [];
					if (plan.duplicates > 0) why.push(`${plan.duplicates} 条库里已经有一模一样的话`);
					if (normalized.dropped.short > 0) why.push(`${normalized.dropped.short} 条太短`);
					if (normalized.dropped.secret > 0) why.push(`${normalized.dropped.secret} 条疑似密钥`);
					if (normalized.dropped.long > 0) why.push(`${normalized.dropped.long} 条太长`);
					if (normalized.dropped.retired > 0) why.push(`${normalized.dropped.retired} 条在源里已收回`);
					return `没有新东西可导：${intakeLabel(entry)} 的 ${read.total} 条里，${why.length > 0 ? why.join("、") : "没有一条能用"}。\n这份以后不再提；文件本身没动。`;
				}
				const written = writeIntake(deps, plan, entry.plugin, now);
				recordImported(engine, entry, plan, now);
				const lines = [renderIntakeDone({
					entry,
					plan,
					written,
					aliasLimit
				})];
				if (args.aliases === true) lines.push("", renderAliasReport(await engine.rebuildAliases({
					identityId: actor.id,
					sessionId,
					limit: args.limit,
					route: routeOf(engine, sessionId)
				})));
				return lines.join("\n");
			}
		}),
		tool({
			name: "memory_handoff",
			description: "生成一张交接卡：我是谁、我们的关系、不能破的规矩、未完成的事，供换会话或换模型时快速接上。只读，不修改人设与记忆。",
			parameters: {},
			run: (_args, exec) => {
				const { sessionId, actor } = actorOf(deps, exec);
				return composeHandoff(deps, sessionId, actor);
			}
		}),
		tool({
			name: "memory_episodes",
			description: "列出记忆里的事件块：每块是一次相对完整的经历，带标题、摘要、时间、类型和关联事实数，按时间倒序。用来把同一件事、同一个项目的几段自己归拢，也可以检查某段经历到底被记成了什么。只读。",
			parameters: {
				query: {
					type: "string",
					description: "可选：关键词，按标题与摘要过滤"
				},
				days: {
					type: "integer",
					description: "可选：只看最近 N 天"
				},
				limit: {
					type: "integer",
					description: "返回条数，默认 20，最多 100"
				}
			},
			run: (args, exec) => {
				const { sessionId, actor } = actorOf(deps, exec);
				return listEpisodes(deps, sessionId, actor, args);
			}
		})
	];
}
/**
* Build the handoff card.
*
* Why not let it write the card back into memory: the identity and boundary
* zones are the part that must not drift, and anything the model summarises on
* its own will drift. So this tool only *reads* — the rule sections are quoted
* from the persona card and the standing preferences verbatim, and "next step"
* is left blank for a human to fill.
*
* @param deps - engine and config.
* @param sessionId - the session asking.
* @param actor - the identity resolved for that session.
* @returns the card as plain text.
*/
function composeHandoff(deps, sessionId, actor) {
	const { engine, config } = deps;
	const zh = config.locale !== "en";
	const now = engine.now();
	const zones = new Map(engine.store.personaZones().map((zone) => [zone.zone, zone.text.trim()]));
	const impression = engine.store.getImpression(actor.id);
	const preferences = engine.store.recentPreferences(actor.id, 5);
	const plans = engine.store.db.prepare("SELECT text FROM facts WHERE identity_id = ? AND kind = 'plan' AND status = 'active' ORDER BY updated_at DESC LIMIT 5").all(actor.id).map((row) => String(row["text"]));
	const events = engine.store.recentEvents(actor.id, 3);
	const when = formatDateTime(now, engine.timezoneOf(sessionId));
	const title = zh ? "交接卡" : "Handoff card";
	const blank = zh ? "（留空，由你或用户填）" : "(left blank on purpose)";
	const lines = [`【${title}】${when}`, ""];

	const section = (label, body) => {
		if (body.length === 0) return;
		lines.push(zh ? `■ ${label}` : `## ${label}`);
		for (const row of body) lines.push(row);
		lines.push("");
	};

	/*
	* Voice and values belong in "who I am" as much as identity does: after a
	* model switch they are what keeps the same character speaking. Leaving them
	* out made the card read like a job description.
	*/
	const self = [];
	for (const zone of ["identity", "voice", "values"]) {
		const text = zones.get(zone) ?? "";
		if (text.length > 0) self.push(`  ${text}`);
	}
	section(zh ? "我是谁" : "Who I am", self);

	const relation = [];
	if ((zones.get("relationship") ?? "").length > 0) relation.push(`  ${zones.get("relationship")}`);
	if (impression !== void 0 && impression.text.trim().length > 0) relation.push(`  ${zh ? "我对你的印象" : "My impression"}：${clip(impression.text.trim(), 300)}`);
	relation.push(`  ${zh ? "关系" : "Role"}：${actor.role}`);
	section(zh ? "我们是什么关系" : "What we are to each other", relation);

	const rules = [];
	if ((zones.get("boundaries") ?? "").length > 0) rules.push(`  ${zones.get("boundaries")}`);
	for (const preference of preferences) rules.push(`  - ${preference.text}`);
	if (rules.length > 0) rules.push(`  ${zh ? "（以上是原文引用，这张卡不改动它们；要改请用 memory_persona / memory_write）" : "(quoted verbatim; this card never edits them — use memory_persona / memory_write)"}`);
	section(zh ? "不能破的规矩" : "Rules that must not break", rules);

	const open = [];
	for (const plan of plans) open.push(`  - ${plan}`);
	for (const event of events) open.push(`  - [${shortDate(event.endedAt, engine.timezoneOf(sessionId), now, config.locale)}] ${event.title}`);
	section(zh ? "未完成" : "Left open", open);

	section(zh ? "下一步" : "Next step", [`  ${blank}`]);

	return lines.join("\n").trimEnd();
}

/**
* List episode blocks as an index a reader can group by hand.
*
* The plugin never models projects: it does not read a working directory, so it
* cannot know that two conversations are about the same repository. What it does
* have is one block per episode, each with its own title and summary — enough for
* the model, or the user, to build the grouping on top. That only works if the
* blocks can be *enumerated*; `memory_search` finds a block only when the query
* already names it, which is the case where you no longer need an index.
*
* @param deps - engine and config.
* @param sessionId - the session asking.
* @param actor - the identity resolved for that session.
* @param args - optional `query`, `days`, `limit`.
* @returns the blocks as plain text, newest first.
*/
/**
* 三十秒演完一整圈：说要做某事 → 到日子 → 它回来问 → 你答了 → 记成事实。
*
* 跑在 `:memory:` 上，用一根可以拨的假时钟推进日子，所以不写一个字节到磁盘，
* 也不读真实库。每一步走的都是生产代码：`writeFact` 负责解析「下周五」，
* `recall` 的计划通道负责挑出来，`renderMemoryBlock` 负责拼成行，`resolve`
* 负责收尾写新事实。这里没有为演示另写一套渲染 —— 那样演的就是另一套东西了，
* 而演示的全部价值在于「你看到的这行字，就是以后真会出现在提示词里的那行」。
* @param deps - engine and config.
* @returns the demo transcript.
*/
function runDemo(deps) {
	const { engine, config } = deps;
	const zh = config.locale !== "en";
	const timezone = engine.timezoneOf("");
	const start = engine.now();
	let cursor = start;
	/*
	* 演示库必须与真库完全隔离，且必须能拨表。`now` 是个函数，拨一次 cursor
	* 整个引擎的「现在」就跟着走 —— 这是 harness 之外唯一不需要等待就能让
	* 日子过去的地方。
	*/
	const demo = MemoryEngine.open({
		path: ":memory:",
		config,
		now: () => cursor,
		timezone
	});
	const out = [];
	const say = (line = "") => out.push(line);
	const sessionId = "demo";
	let identity;
	/** 渲染一次记忆块，只挑出与这条计划相关的那一行。 */
	const lineFor = (at, needle) => {
		const result = recall({
			store: demo.store,
			config: demo.config,
			now: at,
			query: needle,
			identityId: identity.id,
			sessionId
		});
		const block = renderMemoryBlock(result, demo.config, timezone, at);
		return block.split("\n").find((row) => row.includes(needle)) ?? (zh ? "（块里没有这一行）" : "(not in the block)");
	};
	try {
		demo.ensureSession(sessionId);
		identity = demo.identityOf(sessionId);
		const text = zh ? "下周五去体检" : "dentist next Friday";
		const written = demo.writeFact({
			identity,
			sessionId,
			text,
			kind: "plan"
		});
		const plan = typeof written.id === "number" ? demo.store.getFact(written.id) : void 0;
		if (plan === void 0) {
			say(zh ? "演示没跑起来：这条计划没能写进去。" : "The demo could not write its plan.");
			return out.join("\n");
		}
		const dueAt = plan.expiresAt ?? null;
		say(zh ? "记忆演示 —— 一次性的内存库，你的记忆和这个库没有任何关系。" : "Memory demo — a throwaway in-memory store. Nothing here touches your memory.");
		say();
		say(zh ? `【第 1 天 · ${formatDateTime(start, timezone)}】你说：${text}` : `[day 1 · ${formatDateTime(start, timezone)}] you say: ${text}`);
		say(
			zh
				? `它记成计划 #${String(plan.id)}，期限 ${dueAt === null ? "未定期限" : formatDateTime(dueAt, timezone)}。`
				: `Stored as plan #${String(plan.id)}, due ${dueAt === null ? "(none)" : formatDateTime(dueAt, timezone)}.`
		);
		say(zh ? "此刻记忆块里那一行是：" : "Right now that line in the block reads:");
		say(`  ${lineFor(start, text)}`);
		say();
		if (dueAt === null) {
			say(zh ? "（这句话里没解析出日期，所以不会有下文。换成「下周五」这类说法再试。）" : "(No date was parsed out of that sentence, so there is nothing to ask about.)");
			return out.join("\n");
		}
		/*
		* 拨到期限之后。这不是「等两周」，是把时钟推过去 —— 中间那一天里
		* 记忆块什么都不说，正是用户装完头两周看到的样子。
		*/
		cursor = dueAt + 36e5;
		say(zh ? `【第 N 天 · ${formatDateTime(cursor, timezone)}】期限过了，你照常聊天` : `[later · ${formatDateTime(cursor, timezone)}] the date has passed, you talk as usual`);
		say(zh ? "记忆块里那一行变成：" : "The line becomes:");
		say(`  ${lineFor(cursor, text)}`);
		say();
		const answered = demo.resolve({
			identity,
			sessionId,
			id: plan.id,
			outcome: "done"
		});
		if (!answered.resolved) {
			say(zh ? `（收尾没成功：${answered.reason ?? "未知原因"}）` : `(could not resolve: ${answered.reason ?? "unknown"})`);
			return out.join("\n");
		}
		say(zh ? `你答「去了」。它写一条新事实 #${String(answered.factId)}，原来那条计划不再出现：` : `You say "yes, I went". It writes new fact #${String(answered.factId)}, and the plan leaves the block:`);
		say(`  ${lineFor(cursor, zh ? "已办成" : "done")}`);
		say();
		say(
			zh
				? "演示到此结束。真实使用里唯一不同的是：上面这些日子是真的要等的 —— 你今天说的话，到日子之后它才会开口。"
				: "That is the whole loop. The only difference in real use is that those days are actually waited for."
		);
		return out.join("\n");
	} catch (error) {
		return zh ? `演示跑失败：${clip(String(error?.message ?? error), 200)}` : `demo failed: ${clip(String(error?.message ?? error), 200)}`;
	} finally {
		demo.close();
	}
}
function listEpisodes(deps, sessionId, actor, args) {
	const { engine, config } = deps;
	const zh = config.locale !== "en";
	const now = engine.now();
	const timezone = engine.timezoneOf(sessionId);
	const limit = Math.max(1, Math.min(100, Number.isInteger(args.limit) ? args.limit : 20));
	const days = Number.isInteger(args.days) && args.days > 0 ? args.days : 0;
	const since = days > 0 ? now - days * 864e5 : 0;
	const query = typeof args.query === "string" ? args.query.trim() : "";
	const pool = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (event) => {
		if (seen.has(event.id) || event.endedAt < since) return;
		seen.add(event.id);
		pool.push(event);
	};
	if (query.length > 0) {
		const match = compileMatch(query);
		if (match !== void 0) for (const hit of engine.store.searchEvents(actor.id, match, limit * 2)) push(hit);
		/*
		* FTS joins its bigrams with AND, so a natural sentence misses blocks it
		* obviously should match. One scan of the recent blocks covers the case
		* where the wanted word is already sitting in a title.
		*/
		const needle = query.toLowerCase();
		for (const event of engine.store.recentEvents(actor.id, 500)) {
			if (`${event.title} ${event.summary}`.toLowerCase().includes(needle)) push(event);
		}
	} else {
		for (const event of engine.store.recentEvents(actor.id, limit * 2)) push(event);
	}
	if (pool.length === 0) return zh ? "没有符合条件的事件块。记忆是一段对话聊完之后才分块写入的，刚装上时库是空的。" : "No episodes match. Blocks are written after a stretch of conversation, so a fresh library is empty.";
	pool.sort((left, right) => right.endedAt - left.endedAt);
	const chosen = pool.slice(0, limit);
	const lines = chosen.map((event, index) => {
		const facts = engine.store.eventFactIds(event.id).length;
		const when = formatDateTime(event.endedAt, timezone).slice(5);
		const tail = facts > 0 ? (zh ? ` · ${facts} 条事实` : ` · ${facts} facts`) : "";
		/*
		* On the rule path the title is cut from the same sentence the summary
		* keeps, so printing both repeats the line almost word for word. When the
		* two share a long enough opening, the title alone is printed.
		*/
		const bare = event.title.replace(/…$/u, "");
		const full = event.summary.trim();
		let common = 0;
		while (common < bare.length && common < full.length && bare[common] === full[common]) common++;
		const body = common >= Math.min(12, bare.length) ? "" : clip(full, 90);
		return `${index + 1}. [${when} · ${event.domain} · E${event.id}${tail}] ${event.title}${body.length > 0 ? ` —— ${anchorRelativeTime(body, event.endedAt, timezone, now, zh ? "zh" : "en")}` : ""}`;
	});
	const sessions = new Set(chosen.map((event) => event.sessionId));
	const footer = zh
		? `共 ${chosen.length} 块，来自 ${sessions.size} 个会话。想按项目看，照标题里的对象名分组即可；要某块的原文用 memory_expand。`
		: `${chosen.length} blocks across ${sessions.size} sessions. Group them by the object named in each title; use memory_expand for the raw turns.`;
	return [`【事件块】${formatDateTime(now, timezone)}`, ...lines, "", footer].join("\n");
}

/** Human-readable byte count for the doctor report. */
function humanSize(bytes) {
	if (!Number.isFinite(bytes) || bytes < 0) return "未知";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
* One read-only health report, one probe per line.
*
* Every probe is isolated: a dead connection must still produce a report about
* the dead connection, not an exception thrown into the tool layer. This is the
* counterpart of guardPrompt() — that one keeps the turn alive, this one tells
* the user (and the model) where it broke.
*
* @param deps - engine, config and the prompt-health registry.
* @param sessionId - session whose per-prompt failure counters to report.
*/
function diagnose(deps, sessionId) {
	const { engine, config } = deps;
	const lines = [];
	const hints = [];
	let problems = 0;
	const ok = (label, detail) => lines.push(`✓ ${label}${detail === void 0 ? "" : `  ${detail}`}`);
	const info = (label, detail) => lines.push(`· ${label}${detail === void 0 ? "" : `  ${detail}`}`);
	const bad = (label, detail, hint) => {
		problems += 1;
		lines.push(`✗ ${label}${detail === void 0 ? "" : `  ${detail}`}`);
		if (hint !== void 0) hints.push(hint);
	};
	const when = (ms) => {
		const value = Number(ms);
		try {
			return formatDateTime(value, engine.timezoneOf(sessionId));
		} catch {
			// 引擎已关闭时 timezoneOf 也会抛：用本机时区兜底
			try {
				return new Date(value).toLocaleString("zh-CN", { hour12: false });
			} catch {
				return String(value);
			}
		}
	};
	/*
	* 第一行就报版本。升级后没重启时，用户看到的每个症状（工具少几个、库 schema 没升、
	* 新工具 unknown）都指向同一个原因，而这一行能把那个原因直接说出来。
	*/
	try {
		const dbVersion = Number(engine.store.db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0);
		const previous = engine.store.getMeta("runtime.previousVersion");
		const upgraded = previous !== void 0 && previous !== BUILD_VERSION ? ` · 库上次由 ${previous} 打开` : "";
		if (dbVersion === SCHEMA_VERSION) info("版本", `运行 ${BUILD_VERSION} · 库 schema v${dbVersion}${upgraded}`);
		else bad("版本", `运行 ${BUILD_VERSION} · 库 schema v${dbVersion}，代码要求 v${SCHEMA_VERSION}`, "库的 schema 比代码旧，说明迁移没跑完。先复制一份 loom.db 留底，再重启 DSH。");
	} catch (error) {
		info("版本", `运行 ${BUILD_VERSION}（库 schema 读不到：${clip(String(error?.message ?? error), 60)}）`);
	}
	let db = null;
	try {
		db = engine.store.db;
		db.prepare("SELECT 1 AS ok").get();
		ok("库连接", "SELECT 1 正常");
	} catch (error) {
		db = null;
		bad("库连接", clip(String(error?.message ?? error), 140), "库连不上：先确认没有第二个 DSH 实例占着它，再重启 DSH。不要删库。");
	}
	try {
		const stat = statSync(config.path);
		ok("库文件", `${humanSize(stat.size)} · 修改于 ${when(stat.mtimeMs)}`);
	} catch (error) {
		const missing = error?.code === "ENOENT";
		bad("库文件", missing ? `不存在：${config.path}` : clip(String(error?.message ?? error), 140), missing ? `路径 ${config.path} 下没有 loom.db：确认 config.path 没变、DSH_HOME 没被换过。` : void 0);
	}
	try {
		const wal = statSync(`${config.path}-wal`);
		info("WAL", `${humanSize(wal.size)} · 修改于 ${when(wal.mtimeMs)}`);
	} catch {
		info("WAL", "不存在（没有未落盘的写入，或库被正常关闭）");
	}
	if (db !== null) {
		try {
			const mode = String(Object.values(db.prepare("PRAGMA journal_mode").get())[0] ?? "");
			const level = String(Object.values(db.prepare("PRAGMA synchronous").get())[0] ?? "");
			if (mode.toLowerCase() === "wal") ok("日志模式", `journal=${mode} synchronous=${level}`);
			else bad("日志模式", `journal=${mode}（期望 wal）`, "库不是 WAL 模式：并发写入容易互相锁住。");
		} catch (error) {
			bad("日志模式", clip(String(error?.message ?? error), 140));
		}
		try {
			const verdict = String(Object.values(db.prepare("PRAGMA quick_check").get())[0] ?? "");
			if (verdict === "ok") ok("完整性", "quick_check ok");
			else bad("完整性", `quick_check 返回 ${clip(verdict, 140)}`, `库文件可能已损坏：先复制 ${config.path} 和 ${config.path}-wal 留底，再重建。`);
		} catch (error) {
			bad("完整性", clip(String(error?.message ?? error), 140));
		}
		const parts = [];
		const unreadable = [];
		for (const [table, label] of [
			["facts", "事实"],
			["events", "事件"],
			["diary", "日记"],
			["loom_hooks", "钩子"],
			["loom_docs", "正文"],
			["traces", "轨迹"]
		]) {
			try {
				parts.push(`${label} ${db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n}`);
			} catch {
				unreadable.push(table);
			}
		}
		if (unreadable.length === 0) info("数据", parts.join(" · "));
		else bad("数据", `读不出 ${unreadable.join("/")}`, "部分表读不出来：库结构可能不完整，先备份再重建。");
		/*
		* 抽取的校验位：模型每条事实都该带一句「原文摘抄」，代码在本地比一次
		* 子串就知道它有没有编。分母只数**带 quote 的行**——规则路径没有 quote，
		* v0.2.29 之前写进来的也没有，把它们算进分母会让这个比例永远是假的。
		*
		* 一行都不报比报 0/0 好：冷库里这行本来就没有意义，多出来的每一行都在
		* 教用户跳过医生的输出。
		*/
		try {
			/*
			* `live` is not decoration here. This line is the only place the
			* user is told which facts to look at, and its advice is to delete
			* the ones that turn out to be composed — so it has to stop counting
			* them afterwards, or following the advice leaves the ✗ on screen
			* forever and teaches the user the line means nothing.
			*/
			const live = "status IN ('active','disputed')";
			const row = db.prepare(`
        SELECT
          SUM(CASE WHEN evidence LIKE '%"quoteVerified":true%' THEN 1 ELSE 0 END) AS ok,
          SUM(CASE WHEN evidence LIKE '%"quoteVerified":false%' THEN 1 ELSE 0 END) AS off
        FROM facts WHERE ${live}
      `).get();
			const off = Number(row?.["off"] ?? 0);
			const checked = Number(row?.["ok"] ?? 0) + off;
			if (off > 0) {
				/*
				* Name up to two of them. A count alone sends the user to search a
				* store they cannot query; naming the rows makes the next action
				* (`memory_expand`, then `memory_forget`) reachable in one step.
				*/
				const samples = db.prepare(`SELECT text FROM facts WHERE ${live} AND evidence LIKE '%"quoteVerified":false%' ORDER BY id DESC LIMIT 2`).all().map((hit) => `「${clip(String(hit["text"]), 18)}」`).join("");
				bad("引用核对", `${checked} 条带出处，${off} 条对不上原文`, `这 ${off} 条的「原文摘抄」在对话里找不到${samples === "" ? "" : `（${samples}）`}。多半是模型改写主语（原文说「我」，摘抄写成「用户」），也可能是它补出来的。用 memory_expand 打开那段的原话核对：确实是编的就 memory_forget，只是改写就不用管。`);
			} else if (checked > 0) info("引用核对", `${checked} 条带出处，全部对得上`);
		} catch {}
		/*
		* Aliases are written at the moment a fact is written, so a store that
		* predates them (or a stretch where the model ignored the field) is
		* perfectly healthy and still unreachable by paraphrase. Report the
		* coverage instead of pretending the feature exists.
		*/
		try {
			const live = "status IN ('active','disputed')";
			const total = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live}`).get()["n"]);
			const covered = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live} AND aliases <> ''`).get()["n"]);
			if (config.consolidation.aliasCount === 0) info("检索别名", "已关闭");
			else if (total === 0) info("检索别名", "还没有事实");
			else info("检索别名", `${covered}/${total} 条带别名${covered < total ? `（${total - covered} 条没别名：换种说法就搜不到。memory_import(aliases=true) 可以批量补，要调模型）` : ""}`);
		} catch (error) {
			bad("检索别名", clip(String(error?.message ?? error), 140));
		}
		/*
		* 抽取出多少东西。这个数字别处看不到：事件数在「数据」行里有，
		* 但「几个事件挂着事实」决定了问起那些事时，能不能从标题走到内容。
		*
		* 真实库曾经是 3/13 —— 十段对话没留下任何一句可单独检索的话，而所有
		* 指标都是绿的。提示词口径这种东西改完没有当场反馈，就只能等用户抱怨
		* 「它不记得我说过什么」，所以把它放在这里，让下一次收紧或放宽有个数。
		*
		* 只在「一个都没挂上」时才多说一句。挂了一半不是异常：一段纯寒暄、
		* 一段只是在让助手干活，本来就抽不出东西，把它们报成问题会让真正的
		* 问题沉在噪音里。
		*/
		try {
			const events = asNumber$1(db.prepare("SELECT COUNT(*) AS n FROM events WHERE status = 'active'").get()["n"]);
			if (events > 0) {
				const attached = asNumber$1(db.prepare("SELECT COUNT(DISTINCT event_id) AS n FROM event_facts").get()["n"]);
				const facts = asNumber$1(db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status IN ('active','disputed')").get()["n"]);
				info("抽取", `${events} 个事件 · ${facts} 条事实 · ${attached} 个事件挂着事实${attached === 0 ? "（一条都没挂上：整合可能没跑完，或抽取一直空手而归）" : ""}`);
			}
		} catch (error) {
			bad("抽取", clip(String(error?.message ?? error), 140));
		}
		/*
		* 模型预算。这个数字以前在任何地方都看不到：配额用尽后 canUseLlm 返回
		* false，抽取静默退回规则路径，事实变少而所有指标还是绿的。用户能感知
		* 到的只有「它好像不太记得了」，而那种感知要过几天才形成。
		*
		* 报「今天用了几次」而不是只报「有没有用尽」，因为用尽是个瞬时状态：
		* 明天零点自己好，用户真正需要知道的是现在离那条线还有多远。
		*/
		try {
			const limit = config.consolidation.dailyLlmCalls;
			if (!config.consolidation.enabled) info("模型预算", "整合已关闭：只记原文，不抽取事实");
			else if (limit <= 0) info("模型预算", "配额设为 0：全部走规则抽取");
			else {
				const owner = db.prepare("SELECT identity_id FROM sessions WHERE session_id = ?").get(sessionId);
				const identityId = typeof owner?.["identity_id"] === "string" ? owner["identity_id"] : null;
				let tail = "";
				try {
					/*
					* Filter by the identity that owns this session, not "the last
					* consolidate anywhere": in a multi-identity store the newest row
					* may belong to someone else, and the doctor would report their
					* degradation on this person's budget line. Falls back to no line
					* when the session has no audit yet — silence beats a wrong number.
					*/
					const latest = identityId === null ? db.prepare("SELECT detail FROM audit WHERE action = 'memory.consolidate' ORDER BY at DESC LIMIT 1").get() : db.prepare(`SELECT a.detail AS detail FROM audit a JOIN sessions s ON s.session_id = a.entity_id
              WHERE a.action = 'memory.consolidate' AND a.entity = 'session' AND s.identity_id = ?
              ORDER BY a.at DESC LIMIT 1`).get(identityId);
					const detail = JSON.parse(String(latest?.["detail"] ?? ""));
					if (detail?.degraded === true) {
						/*
						* 「降级」这个词只留给真的没抽出事实的那两种。判断层走规则
						* 不算：事实已经在库里，只是四条判断改由规则给出，用户什么
						* 都不用做。混在一起说，一次完全正常的整合也会看起来像出了
						* 问题，而跟着提示去查配额又查不出东西。
						*/
						const hard = ["budget", "model"].filter((kind) => asNumber$1(detail.reasons?.[kind]) > 0).map((kind) => `${DEGRADE_LABEL[kind]} ${asNumber$1(detail.reasons[kind])} 段`).join("、");
						if (hard !== "") tail = ` · 最近一次整合降级（${hard}）`;
						else if (asNumber$1(detail.reasons?.["judge"]) > 0) tail = " · 最近一次整合：事实已抽出，判断改由规则给出";
					}
				} catch {}
				if (identityId === null) info("模型预算", `配额 ${limit} 次/天${tail}`);
				else {
					const used = asNumber$1(engine.dailyCalls(identityId));
					if (used >= limit) bad("模型预算", `今日已用 ${used}/${limit}，配额用尽：接下来只走规则抽取${tail}`, "配额用尽不是故障：原话仍然入库，只是抽不出压缩后的事实，之后更难被搜到。明天零点自动恢复，也可以调大 consolidation.dailyLlmCalls。一次性导入大量历史之前，先确认这个数够用。");
					else if (used >= limit * .9) info("模型预算", `今日已用 ${used}/${limit}，接近上限${tail}`);
					else info("模型预算", `今日已用 ${used}/${limit}${tail}`);
				}
			}
		} catch (error) {
			bad("模型预算", clip(String(error?.message ?? error), 140));
		}
		/*
		* Memory files left behind by another plugin, and whether anybody has
		* answered the offer yet.
		*
		* This line exists because the prompt notice goes quiet after a few turns
		* on purpose (a plugin that asks every turn is a plugin people uninstall),
		* and a person who remembers 「好像提过可以导入」 needs somewhere to look.
		* Read from meta, so it costs one row and never touches the disk.
		*/
		try {
			const pending = pendingIntake(engine.store);
			const scannedAt = Number(engine.store.getMeta("intake.scanAt") ?? 0);
			const tail = scannedAt > 0 ? ` · 上次扫描 ${when(scannedAt)}` : " · 还没扫描过";
			if (pending.length > 0) info("可导入", `${pending.map((entry, index) => `${index + 1}. ${intakeLabel(entry)}${entry.rows === null ? "" : ` ${entry.rows} 条`}`).join(" · ")}${tail}（memory_import 先看清单，不会自动写库）`);
			else info("可导入", `没有待导入的${tail}`);
		} catch (error) {
			bad("可导入", clip(String(error?.message ?? error), 140));
		}
		/*
		* Plans and disputed rows, in one line: they are the two states a fact can
		* be in without being either "current" or "gone". Printing the counts keeps
		* the conflict scanner honest — if it ever flags a large share of the store
		* the threshold is wrong, and that should be visible rather than inferred
		* from a block that suddenly marks everything stale.
		*/
		try {
			const live = "status IN ('active','disputed')";
			const total = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live}`).get()["n"]);
			const plans = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live} AND kind = 'plan'`).get()["n"]);
			const disputed = asNumber$1(db.prepare("SELECT COUNT(*) AS n FROM facts WHERE status = 'disputed'").get()["n"]);
			const overdue = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live} AND kind = 'plan' AND resolved_at IS NULL AND (expired_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?))`).get(engine.now())["n"]);
			const asked = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live} AND kind = 'plan' AND resolved_at IS NULL AND nudged_at IS NOT NULL`).get()["n"]);
			const settled = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live} AND kind = 'plan' AND resolved_at IS NOT NULL`).get()["n"]);
			const extra = plans === 0 ? "" : `（${overdue} 条已到期${asked > 0 ? ` · ${asked} 条问过没结果` : ""}${settled > 0 ? ` · ${settled} 条已有结果` : ""}）`;
			info("计划与矛盾", `${plans} 条计划${extra} · ${disputed}/${total} 条待确认`);
			/*
			* 报出「下一步哪天动」。只说「1 条计划」等于什么都没说：用户装完看到的
			* 是一份静态清单，而这份清单的价值在于某个日子它会自己开口。等待一旦
			* 有了确切日期就变成可验证的承诺，没有日期就只是「好像记了点东西」。
			* 只报最近的一条，且只报还没收尾的 —— 已经办成或没办成的没什么要等。
			*/
			const next = db.prepare(`SELECT text, expires_at FROM facts WHERE ${live} AND kind = 'plan' AND resolved_at IS NULL AND expires_at IS NOT NULL ORDER BY expires_at ASC LIMIT 1`).get();
			if (next !== undefined) {
				const gap = engine.config.retrieval.planNudgeDays;
				const repeat = gap > 0 ? `，没回答就每 ${gap} 天再问一次` : "";
				info("下一步", `「${clip(String(next["text"]), 20)}」${when(next["expires_at"])} 到期，之后第一次对话就会问${repeat}`);
			}
		} catch (error) {
			bad("计划与矛盾", clip(String(error?.message ?? error), 140));
		}
		/*
		* Time coverage. The interesting number is not how many deadlines exist —
		* it is how many carry a phrase that the parser could not turn into a
		* window. Those render as "未定期限" while the user did say something, and
		* that gap is invisible everywhere else.
		*/
		try {
			const live = "status IN ('active','disputed')";
			/*
			* Plans only. Since v0.2.22 a deadline belongs to a promise, so a
			* non-plan row carrying a phrase is not a parsing gap — counting it as
			* one would report every 「今天我把车卖了」 as a failure.
			*/
			const total = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live} AND kind = 'plan' AND expires_at IS NOT NULL`).get()["n"]);
			const ranged = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live} AND kind = 'plan' AND expires_at IS NOT NULL AND due_from IS NOT NULL AND due_from < expires_at - 864e5`).get()["n"]);
			const pending = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live} AND kind = 'plan' AND evidence LIKE '%pendingDue%'`).get()["n"]);
			const unparsed = asNumber$1(db.prepare(`SELECT COUNT(*) AS n FROM facts WHERE ${live} AND kind = 'plan' AND expires_at IS NULL AND evidence LIKE '%ttlPhrase":"%'`).get()["n"]);
			if (total === 0 && unparsed === 0) info("时间", "还没有带期限的记忆");
			else info("时间", `${total} 条有期限（${ranged} 条是区间）${pending > 0 ? ` · ${pending} 条时间待确认` : ""}${unparsed > 0 ? ` · ${unparsed} 条只记了原话没算出日期` : ""}`);
		} catch (error) {
			bad("时间", clip(String(error?.message ?? error), 140));
		}
		try {
			const row = db.prepare("SELECT at FROM traces WHERE operation = 'recall' ORDER BY at DESC LIMIT 1").get();
			if (row === void 0) info("最近召回", "还没有召回记录（新库，或整合尚未触发）");
			else {
				const at = Number(row.at);
				const minutes = Math.round((engine.now() - at) / 6e4);
				info("最近召回", `${when(at)}（${minutes} 分钟前）`);
			}
		} catch (error) {
			bad("最近召回", clip(String(error?.message ?? error), 140));
		}
	}
	const state = deps.health?.get(sessionId);
	const broken = [];
	let worstCount = 0;
	for (const label of ["persona", "hooks", "memory"]) {
		const entry = state?.[label];
		if (entry === void 0) continue;
		worstCount = Math.max(worstCount, entry.count);
		broken.push(`${label} 连续 ${entry.count} 次（${entry.error}）`);
	}
	if (broken.length === 0) ok("prompt 块", "本轮三块都读到了");
	else if (worstCount >= 3) bad("prompt 块", broken.join("；"), "库本身也许是好的：把上面 prompt 块的错误原文发给维护者。");
	else info("prompt 块", `${broken.join("；")}（未到 3 次，暂不告警）`);
	try {
		const root = engine.diaryMirror?.root;
		if (typeof root === "string" && root.length > 0) info("日记目录", root);
	} catch {}
	lines.push("", problems === 0 ? "结论：未发现故障 —— 库可读，三块 prompt 本轮都正常。" : `结论：发现 ${problems} 处问题。`);
	if (problems > 0) lines.push(`下一步：${hints.length > 0 ? [...new Set(hints)].slice(0, 2).map((hint) => hint.replace(/。$/u, "")).join("；") + "。" : "把这份报告整段发给维护者。"}`);
	return lines.join("\n");
}
/**
* Register the tools on the plugin context.
* @param ctx - plugin context providing `tools`.
* @param deps - engine and config.
*/
function registerTools(ctx, deps) {
	for (const definition of buildTools(deps)) {
		/*
		* Remember the exact object, not the name: the guard's `get()` returns
		* whatever the host stored, so identity is what separates "another
		* plugin took this name" from "we took it earlier in this process".
		*/
		OWN_TOOLS.add(definition);
		ctx.tools.register(definition);
	}
}

//#endregion
//#region src/index-layer.ts
/**
 * The hook index — a pointer-only layer over the store.
 *
 * The prompt carries hooks (~15 tokens each). Bodies never enter the context
 * window; they stay in `l0` and are pulled on demand via `memory_expand`.
 * Zero extra model calls: `events.l0_from/l0_to` already points at the body.
 *
 * The resident hook set is a snapshot in `loom_hooks`, rebuilt on a timer or
 * on demand — not re-sorted every turn. Stability is what prevents persona
 * drift; a per-turn top-N race is exactly what causes it.
 */
const INDEX_SCHEMA = `
  CREATE TABLE IF NOT EXISTS loom_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    chars INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS loom_docs_identity ON loom_docs(identity_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS loom_links (
    identity_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    doc_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (identity_id, ref)
  );

  CREATE TABLE IF NOT EXISTS loom_hooks (
    identity_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    kind TEXT NOT NULL,
    target INTEGER NOT NULL,
    label TEXT NOT NULL,
    score REAL NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    resident INTEGER NOT NULL DEFAULT 0,
    access_count INTEGER NOT NULL DEFAULT 0,
    cold_until INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (identity_id, ref)
  );
  CREATE INDEX IF NOT EXISTS loom_hooks_resident ON loom_hooks(identity_id, resident, score DESC);
`;
/**
 * `E37` / `F12` / `D3` / `T` → { kind, id }. Case insensitive, `#` allowed.
 * `T` is the tail: turns captured but not yet consolidated, which have no
 * event yet and would otherwise be invisible to the index.
 */
function parseRef(raw) {
	const value = String(raw ?? "").trim();
	if (/^#?\s*t$/iu.test(value)) return { kind: "tail", id: 0 };
	const match = /^#?\s*([efdp])\s*#?(\d+)$/iu.exec(value);
	if (match === null) return null;
	const kind = {
		e: "event",
		f: "fact",
		d: "doc",
		p: "preference"
	}[match[1].toLowerCase()];
	return { kind, id: Number(match[2]) };
}
function normalizeRef(parsed) {
	if (parsed.kind === "tail") return "T";
	return `${{
		event: "E",
		fact: "F",
		doc: "D",
		preference: "P"
	}[parsed.kind]}${parsed.id}`;
}
function sizeHint(chars) {
	return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k字` : `${chars}字`;
}
/**
* Clamp a cut index and step back off a surrogate pair.
* Slicing between a high and a low surrogate yields a lone half, which reaches
* the model as U+FFFD and loses one character per page boundary. Adjacent
* emoji are common in chat, so this is not theoretical.
* @param text - the string being sliced.
* @param index - desired cut index.
* @returns a cut index that never splits a surrogate pair.
*/
function safeCut(text, index) {
	const max = text.length;
	const at = Math.min(Math.max(0, index), max);
	if (at === 0 || at === max) return at;
	const prev = text.charCodeAt(at - 1);
	const splitsPair = prev >= 0xd800 && prev <= 0xdbff;
	if (!splitsPair) return at;
	return at - 1 >= 1 ? at - 1 : Math.min(at + 1, max);
}
/** A slice of `text` starting at `offset` that fits `budget` tokens. */
function sliceByTokens(text, offset, budget) {
	const start = Math.max(0, Number.isFinite(offset) ? offset : 0);
	const rest = text.slice(start);
	if (rest.length === 0) return { piece: "", end: start, done: true };
	// Probe this text's own token-per-char ratio instead of assuming Chinese.
	// The old fixed `budget / 0.65` assumed the densest case, so Latin logs and
	// code (about 0.26) used only ~40% of the budget and doubled the page count.
	// The loop below can only shrink, so the initial guess has to be the right size.
	const probe = rest.slice(0, 2000);
	const ratio = Math.max(.25, estimateTokens(probe) / Math.max(1, probe.length));
	let take = safeCut(rest, Math.min(rest.length, Math.max(1, Math.floor(budget / ratio))));
	let piece = rest.slice(0, take);
	while (piece.length > 1 && estimateTokens(piece) > budget) {
		take = safeCut(rest, Math.max(1, Math.floor(take * .85)));
		piece = rest.slice(0, take);
	}
	if (take < rest.length) {
		const cut = piece.lastIndexOf("\n");
		if (cut > Math.floor(take * .6)) piece = piece.slice(0, cut);
	}
	return { piece, end: start + piece.length, done: start + piece.length >= text.length };
}
/**
 * Read-mostly index over the store this plugin owns. Never mutates the
 * upstream tables; the three `loom_*` tables are its own.
 */
class HookIndex {
	/** @param db - the store's open connection. @param config - index config plus `locale`. */
	constructor(db, config, now = () => Date.now()) {
		this.db = db;
		this.config = config;
		this.now = now;
		this.db.exec(INDEX_SCHEMA);
	}
	/**
	 * The identity a session speaks for, or `null` when the session has no row
	 * yet. Tool paths go through `engine.identityOf` instead, which falls back
	 * to master — consistent with the persona and memory blocks.
	 */
	identityOf(sessionId) {
		const row = this.db.prepare("SELECT identity_id FROM sessions WHERE session_id = ?").get(sessionId);
		return row === void 0 ? null : row.identity_id;
	}
	/** Rebuild the resident snapshot for one identity. */
	rebuild(identityId) {
		const now = this.now();
		const candidates = [];
		const events = this.db.prepare(`
      SELECT e.id, e.title, e.summary, e.salience, e.ended_at, e.l0_from, e.l0_to,
             COALESCE((SELECT SUM(LENGTH(l.text)) FROM l0 l WHERE l.id BETWEEN e.l0_from AND e.l0_to), 0) AS chars
      FROM events e
      WHERE e.identity_id = ? AND e.status = 'active'
      ORDER BY e.ended_at DESC LIMIT 300
    `).all(identityId);
		for (const event of events) {
			const recency = Math.max(0, 1 - (now - event.ended_at) / (1000 * 60 * 60 * 24 * 180));
			candidates.push({
				ref: `E${event.id}`,
				kind: "event",
				target: event.id,
				label: `${clip(event.title, 16)}${event.chars > 0 ? ` ${sizeHint(event.chars)}` : ""}`,
				score: .75 * event.salience + .25 * recency
			});
		}
		const facts = this.db.prepare(`
      SELECT id, text, pinned, salience, updated_at
      FROM facts
      WHERE identity_id = ? AND status = 'active' AND (pinned = 1 OR salience >= 0.55)
      ORDER BY pinned DESC, updated_at DESC LIMIT 150
    `).all(identityId);
		for (const fact of facts) {
			const recency = Math.max(0, 1 - (now - fact.updated_at) / (1000 * 60 * 60 * 24 * 365));
			candidates.push({
				ref: `F${fact.id}`,
				kind: "fact",
				target: fact.id,
				label: `${fact.pinned === 1 ? "★" : ""}${clip(fact.text, 22)}`,
				score: (fact.pinned === 1 ? .72 : .24) + .5 * fact.salience + .18 * recency
			});
		}
		const docs = this.db.prepare(`
      SELECT id, title, chars, created_at FROM loom_docs
      WHERE identity_id = ? ORDER BY created_at DESC LIMIT 60
    `).all(identityId);
		for (const doc of docs) {
			candidates.push({
				ref: `D${doc.id}`,
				kind: "doc",
				target: doc.id,
				label: `${clip(doc.title, 18)} ${sizeHint(doc.chars)}`,
				score: .62
			});
		}
		const tail = this.db.prepare(`
      SELECT COUNT(*) AS turns, COALESCE(SUM(LENGTH(text)), 0) AS chars
      FROM l0 WHERE identity_id = ? AND consolidated = 0
    `).get(identityId);
		if (tail.turns > 0) candidates.push({
			ref: "T",
			kind: "tail",
			target: 0,
			label: `最近未整理 · ${tail.turns}轮 ${sizeHint(tail.chars)}`,
			score: .8
		});
		else this.db.prepare("DELETE FROM loom_hooks WHERE identity_id = ? AND ref = 'T'").run(identityId);
		const previous = new Map();
		for (const row of this.db.prepare("SELECT ref, resident, access_count, cold_until FROM loom_hooks WHERE identity_id = ?").all(identityId)) previous.set(row.ref, row);
		for (const candidate of candidates) {
			const before = previous.get(candidate.ref);
			const access = before?.access_count ?? 0;
			candidate.score += Math.min(.2, .05 * Math.log1p(access));
			if (before !== void 0 && before.cold_until !== null && before.cold_until > now) candidate.score -= 10;
		}
		candidates.sort((left, right) => right.score - left.score);
		const header = this.header();
		let used = estimateTokens(header);
		let count = 0;
		const chosen = new Set();
		const shownLabels = new Set();
		const budgetLabel = (label) => label.replace(/\s+\d+(\.\d+)?k?字$/u, "");
		for (const candidate of candidates) {
			if (candidate.score < this.config.minHookScore) continue;
			const label = budgetLabel(candidate.label);
			if (shownLabels.has(label)) continue;
			const cost = estimateTokens(`- ${candidate.ref} ${candidate.label}`) + 1;
			if (count >= this.config.maxHooks) break;
			if (used + cost > this.config.hooksBudgetTokens) break;
			chosen.add(candidate.ref);
			shownLabels.add(label);
			used += cost;
			count++;
		}
		const upsert = this.db.prepare(`
      INSERT INTO loom_hooks (identity_id, ref, kind, target, label, score, tokens, resident, access_count, cold_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_id, ref) DO UPDATE SET
        kind = excluded.kind, target = excluded.target, label = excluded.label,
        score = excluded.score, tokens = excluded.tokens, resident = excluded.resident,
        cold_until = excluded.cold_until, updated_at = excluded.updated_at
    `);
		const coldUntil = now + this.config.coldDays * 86400000;
		for (const candidate of candidates) {
			const before = previous.get(candidate.ref);
			const resident = chosen.has(candidate.ref) ? 1 : 0;
			let cold = before?.cold_until ?? null;
			if (resident === 1) cold = null;
			else if (before?.resident === 1) cold = coldUntil;
			upsert.run(identityId, candidate.ref, candidate.kind, candidate.target, candidate.label, candidate.score, estimateTokens(`- ${candidate.ref} ${candidate.label}`) + 1, resident, before?.access_count ?? 0, cold, now);
		}
		// Hooks whose source is gone (forget / erase / purge) must not linger in
		// the prompt — drop every row that no longer has a candidate.
		const refs = candidates.map((candidate) => candidate.ref);
		if (refs.length > 0) this.db.prepare(`DELETE FROM loom_hooks WHERE identity_id = ? AND ref NOT IN (${refs.map(() => "?").join(", ")})`).run(identityId, ...refs);
		else this.db.prepare("DELETE FROM loom_hooks WHERE identity_id = ?").run(identityId);
		return { resident: chosen.size, candidates: candidates.length, tokens: used };
	}
	/** The resident hook set, as rendered into the prompt. */
	render(identityId) {
		const rows = this.db.prepare(`
      SELECT ref, label FROM loom_hooks
      WHERE identity_id = ? AND resident = 1 ORDER BY score DESC
    `).all(identityId);
		if (rows.length === 0) return "";
		return [this.header(), ...rows.map((row) => `- ${row.ref} ${row.label}`)].join("\n");
	}
	header() {
		return this.config.locale === "en" ? "[Memory index] Hooks only — call memory_expand(ref) when the detail matters. Do not assert specifics from a hook alone." : "【记忆索引】只有钩子，细节用 memory_expand(ref) 取；不要仅凭钩子断言具体内容。";
	}
	/** Whether the memory a doc is hung on still exists (and isn't being deleted). */
	refAlive(key) {
		const parsed = parseRef(key);
		if (parsed === null || parsed.kind === "tail") return true;
		if (parsed.kind === "doc") return this.db.prepare("SELECT 1 AS hit FROM loom_docs WHERE id = ?").get(parsed.id) !== void 0;
		if (parsed.kind === "event") return this.db.prepare("SELECT 1 AS hit FROM events WHERE id = ?").get(parsed.id) !== void 0;
		/*
		* A retired preference is a dead hook. Without this branch the fact query
		* below would answer for `P3` with whatever fact happens to be #3 — the
		* two id spaces are independent, so the answer would be about an unrelated
		* memory and nothing would look wrong.
		*/
		if (parsed.kind === "preference") return this.db.prepare("SELECT 1 AS hit FROM preferences WHERE id = ? AND active = 1").get(parsed.id) !== void 0;
		const row = this.db.prepare("SELECT status FROM facts WHERE id = ?").get(parsed.id);
		return row !== void 0 && row.status !== "pending_delete";
	}
	/** Docs whose hook is gone — the user asked to forget, so the body must go too. */
	orphanDocs(identityId) {
		const rows = this.db.prepare(`
      SELECT l.ref, l.doc_id, d.title FROM loom_links l
      JOIN loom_docs d ON d.id = l.doc_id
      WHERE l.identity_id = ?
    `).all(identityId);
		return rows.filter((row) => !this.refAlive(row.ref));
	}
	/** Delete those orphan docs. Only runs when the user (or the owner) asks. */
	gc(identityId) {
		const orphans = this.orphanDocs(identityId);
		for (const orphan of orphans) {
			this.db.prepare("DELETE FROM loom_links WHERE identity_id = ? AND doc_id = ?").run(identityId, orphan.doc_id);
			this.db.prepare("DELETE FROM loom_docs WHERE id = ? AND identity_id = ?").run(orphan.doc_id, identityId);
		}
		if (orphans.length > 0) this.rebuild(identityId);
		return orphans;
	}
	/** Resolve a ref to its body text. */
	body(identityId, ref) {
		const parsed = parseRef(ref);
		if (parsed === null) return { ok: false, reason: `无法识别的编号：${ref}` };
		if (parsed.kind === "tail") {
			const tail = this.db.prepare(`
        SELECT MIN(id) AS "from", MAX(id) AS "to", COUNT(*) AS turns
        FROM l0 WHERE identity_id = ? AND consolidated = 0
      `).get(identityId);
			if (tail === void 0 || tail.turns === 0) return { ok: false, reason: "现在没有未整理的对话，都已归入事件段" };
			const text = this.rangeText(tail.from, tail.to);
			return { ok: true, label: "最近未整理的对话", kind: "tail", text, chars: text.length, at: null };
		}
		const link = this.db.prepare("SELECT doc_id FROM loom_links WHERE identity_id = ? AND ref = ?").get(identityId, normalizeRef(parsed));
		if (link !== void 0) {
			if (!this.refAlive(normalizeRef(parsed))) return { ok: false, reason: `${normalizeRef(parsed)} 已被删除（用户要求忘记或已过期清理），它的正文不再返回` };
			const doc = this.db.prepare("SELECT title, body, chars, created_at FROM loom_docs WHERE id = ?").get(link.doc_id);
			if (doc !== void 0) return { ok: true, label: doc.title, kind: "doc", text: doc.body, chars: doc.chars, at: doc.created_at };
		}
		if (parsed.kind === "doc") {
			const doc = this.db.prepare("SELECT title, body, chars, created_at FROM loom_docs WHERE id = ? AND identity_id = ?").get(parsed.id, identityId);
			if (doc === void 0) return { ok: false, reason: `没有正文 D${parsed.id}` };
			return { ok: true, label: doc.title, kind: "doc", text: doc.body, chars: doc.chars, at: doc.created_at };
		}
		if (parsed.kind === "event") {
			const event = this.db.prepare("SELECT title, summary, l0_from, l0_to FROM events WHERE id = ? AND identity_id = ?").get(parsed.id, identityId);
			if (event === void 0) return { ok: false, reason: `没有事件 E${parsed.id}` };
			const text = this.rangeText(event.l0_from, event.l0_to);
			if (text.length === 0) return { ok: false, reason: `E${parsed.id} 的原文已被清理（路人保留期或删除请求）。摘要：${clip(event.summary, 120)}` };
			return { ok: true, label: event.title, kind: "event", text, chars: text.length, summary: event.summary, at: null };
		}
		/*
		* A preference's body *is* its text — there is no conversation range to
		* page through, because the row was stored as one sentence (整合时从一段
		* 对话里提炼，或用户直接让记下）。Retired rows are refused rather than
		* served: the user asked to stop applying that rule, and handing the text
		* back as if it were in force is the one reading the retire path exists to
		* prevent.
		*/
		if (parsed.kind === "preference") {
			const preference = this.db.prepare("SELECT text, active, created_at FROM preferences WHERE id = ? AND identity_id = ?").get(parsed.id, identityId);
			if (preference === void 0) return { ok: false, reason: `没有偏好 P${parsed.id}` };
			if (!asBoolean(preference.active)) return { ok: false, reason: `P${parsed.id} 已经不在长期偏好区（用户要求不再适用）` };
			const text = asString$1(preference.text);
			return { ok: true, label: "长期偏好", kind: "preference", text, chars: text.length, at: asNumber$1(preference.created_at) };
		}
		const fact = this.db.prepare("SELECT text, source_ids, pinned, created_at FROM facts WHERE id = ? AND identity_id = ?").get(parsed.id, identityId);
		if (fact === void 0) return { ok: false, reason: `没有事实 F${parsed.id}` };
		let range = [];
		try {
			range = JSON.parse(fact.source_ids ?? "[]");
		} catch {
			range = [];
		}
		const from = Number(range[0]);
		const to = Number(range[range.length - 1]);
		if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: true, label: "", kind: "fact", text: fact.text, chars: fact.text.length, at: fact.created_at };
		const text = this.rangeText(from, to);
		if (text.length === 0) return { ok: true, label: "", kind: "fact", text: fact.text, chars: fact.text.length, at: fact.created_at };
		return { ok: true, label: "", kind: "fact", text, chars: text.length, at: fact.created_at };
	}
	/** Verbatim turn text for an inclusive `l0` id range. */
	rangeText(from, to) {
		const rows = this.db.prepare("SELECT role, text FROM l0 WHERE id >= ? AND id <= ? ORDER BY id").all(from, to);
		const lines = [];
		for (const row of rows) {
			if (row.role === "assistant" && !this.config.includeAssistant) continue;
			lines.push(`${row.role === "user" ? "用户" : "我"}：${row.text}`);
		}
		return lines.join("\n");
	}
	/** Store a curated body and link it to a hook. */
	pack({ identityId, ref, title, text }) {
		const now = this.now();
		const body = String(text).slice(0, this.config.maxCharsPerPack);
		const docTitle = clip(String(title ?? "").trim() || "未命名叙事", 40);
		const id = this.db.prepare("INSERT INTO loom_docs (identity_id, title, body, chars, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(identityId, docTitle, body, body.length, now, now).lastInsertRowid;
		const parsed = ref === void 0 || ref === null || String(ref).trim().length === 0 ? null : parseRef(ref);
		// `T` is a rolling window over un-consolidated turns. Hanging a fixed body
		// on it would both go stale and shadow the live tail, so it is refused.
		const key = parsed === null ? null : normalizeRef(parsed);
		// A hook that does not exist cannot be expanded later (`refAlive` would call
		// it deleted), so linking to it would announce success for a body nobody can
		// ever pull. The doc still becomes its own `D` candidate either way.
		const missingRef = key !== null && parsed.kind !== "tail" && !this.refAlive(key) ? key : null;
		const bindable = key !== null && parsed.kind !== "tail" && missingRef === null;
		if (bindable) this.db.prepare("INSERT OR REPLACE INTO loom_links (identity_id, ref, doc_id, created_at) VALUES (?, ?, ?, ?)").run(identityId, key, id, now);
		this.rebuild(identityId);
		return {
			id: Number(id),
			chars: body.length,
			tokens: estimateTokens(body),
			linked: bindable,
			droppedTail: parsed?.kind === "tail",
			missingRef
		};
	}
	/** Record that a hook was actually pulled. */
	noteAccess(identityId, ref) {
		this.db.prepare("UPDATE loom_hooks SET access_count = access_count + 1 WHERE identity_id = ? AND ref = ?").run(identityId, ref);
	}
}
/** Footer for a `memory_expand` page, including the continue-reading pointer. */
function expandFooter(config, ref, offset, result) {
	const zh = config.locale !== "en";
	const total = result.chars;
	const end = Math.min(total, offset + result.piece.length);
	const head = result.label.length > 0 ? `${zh ? "【正文" : "[Body"} · ${ref} ${result.label}${zh ? "】" : "]"}` : `${zh ? "【正文" : "[Body"} · ${ref}${zh ? "】" : "]"}`;
	const first = offset === 0 ? "" : zh ? `（接上，从第 ${offset + 1} 字开始）\n` : `(continued from char ${offset + 1})\n`;
	if (result.done) return `${head}\n${first}${result.piece}\n—\n${zh ? `全文 ${total} 字，已返回完。` : `${total} chars, end of body.`}`;
	const next = zh ? `全文 ${total} 字，本次返回第 ${offset + 1}-${end} 字。续读：memory_expand(ref="${ref}", offset=${end})` : `${total} chars, returned ${offset + 1}-${end}. Continue with memory_expand(ref="${ref}", offset=${end}).`;
	return `${head}\n${first}${result.piece}\n—\n${next}`;
}
/** The etiquette lines that teach the model how to use the index. */
function renderIndexProtocol(locale) {
	return locale === "en" ? [
		"Memory index protocol:",
		"- The index block holds hooks, not memories. Each line is a label and a ref.",
		"- Call memory_expand(ref) before you state any detail you only know from a hook.",
		"- Hooks are stable across turns; a missing hook means \"not important right now\", not \"forgotten\".",
		"- If a body contradicts what the user just said, the user wins."
	].join("\n") : [
		"记忆索引约定：",
		"- 索引区只有钩子，不是记忆本身；每行是一个标签加一个编号。",
		"- 只凭钩子知道的事，说出口之前先 memory_expand(ref) 取正文。",
		"- 钩子在轮次之间保持稳定；钩子不在索引里只表示「当下不相关」，不表示「忘了」。",
		"- 正文与用户刚说的话冲突时，以用户为准。"
	].join("\n");
}
//#endregion
//#region src/index.ts
/** Plugin display name, as shown in loader diagnostics. */
const name = "memory-loom";
/** Services this plugin needs before `apply` runs. */
const inject = ["tools", "systemPrompt"];
/** Validated configuration schema. */
const Config = Config$1;
/** Join the text blocks of one model message. */
function textOf(content) {
	const parts = [];
	for (const block of content) if (block.type === "text") parts.push(block.text);
	return parts.join("\n").trim();
}
/**
* Install the plugin.
* @param ctx - plugin context.
* @param config - validated plugin config.
*/
function apply(ctx, config) {
	validateConfig(config);
	const logger = ctx.logger("memory-loom");
	/**
	* Everything the model reads passes through here on its way out: the two
	* global protocol sections, the three per-session blocks, and every tool
	* return. One renamer instead of 21 call sites — see `renameToolNames`.
	*/
	const rename = (text) => renameToolNames(text, config.toolPrefix);
	/*
	* Refuse early, in words a person can act on.
	*
	* The host keys tools by name (`NamedEntries.insert` throws on a duplicate)
	* and a throw from `apply()` rolls the *whole* plugin back — not just the
	* colliding tool. At least four memory plugins in this ecosystem ship
	* `memory_search` / `memory_write` / `memory_forget`, so this is the likely
	* first failure a new user hits, and the host's own message names neither
	* the cause nor a way out.
	*
	* Checking all 15 up front (rather than letting `register` fail) also means
	* the message is the same no matter which name collides first.
	*/
	if (config.toolPrefix === DEFAULT_TOOL_PREFIX) {
		const taken = TOOL_SUFFIXES.map((suffix) => `${DEFAULT_TOOL_PREFIX}${suffix}`).find((name) => {
			const existing = ctx.tools.get(name);
			return existing !== void 0 && !OWN_TOOLS.has(existing);
		});
		if (taken !== void 0) throw new Error([
			`memory-loom: 工具名 ${taken} 已被另一个插件占用（多半是另一个记忆插件）。`,
			"DSH 的工具名全局唯一，重名会让整个插件加载失败——所以这一版不会半残运行，也不会顶掉对方。",
			"两种解法，任选一种：",
			"  ① 二选一：dsh plugin --profile <你的 profile> remove <那个记忆插件>（它的记忆文件不会被删除，以后装回来还在）",
			`  ② 共存：在 profile 的 cordis.patch.yml 给本插件设置 toolPrefix: loom_，本插件改用 loom_search 等名字，两套记忆各自保留（代价见 README「和别的记忆插件一起装」）`
		].join("\n"));
	}
	const engineConfig = toEngineConfig(config);
	const bridge = createLlmBridge(ctx, config);
	/** The zone every conversation in this deployment is dated in. */
	const timezone = (() => {
		if (config.timezone.trim().length > 0) return config.timezone.trim();
		try {
			return Intl.DateTimeFormat().resolvedOptions().timeZone;
		} catch {
			return null;
		}
	})();
	/** The readable diary mirror, resolved against `path` instead of any absolute location. */
	const diaryRoot = config.diary.mirror ? diaryMirrorRoot(config.path, config.diary.mirrorDir) : null;
	const engine = MemoryEngine.open({
		path: config.path,
		config: engineConfig,
		llm: bridge.complete,
		ownerName: config.ownerName,
		timezone,
		diaryRoot
	});
	/** The hook index shares the engine's connection; `engine.close()` closes both. */
	const indexStore = new HookIndex(engine.store.db, {
		...config.index,
		locale: config.locale
	}, () => engine.now());
	/*
	* 记下「这次真正跑起来的是哪一版」。升级后没重启时，新代码根本不会执行到这里，
	* 所以这一行同时也是升级是否真的生效的证据：医生里显示的运行版本永远不会撒谎。
	* 上一次的值另存一份——升级第一次启动之后，用户能看见「库上次由 0.2.12 打开」。
	*/
	try {
		const previous = engine.store.getMeta("runtime.version");
		if (previous !== BUILD_VERSION) {
			if (previous !== void 0) engine.store.setMeta("runtime.previousVersion", previous);
			engine.store.setMeta("runtime.version", BUILD_VERSION);
		}
	} catch (error) {
		logger.warn(`memory-loom: 记不下运行版本（${String(error?.message ?? error)}），不影响记忆`);
	}
	if (diaryRoot !== null) {
		const written = engine.syncDiary(config.diary.mirrorDays);
		logger.info(`diary mirror at ${diaryRoot}${written.length > 0 ? ` (${written.length} day file(s) written)` : ""}`);
	}
	let closed = false;
	ctx.effect(() => () => {
		closed = true;
		engine.close();
	}, "memory-loom:store");
	ctx.systemPrompt.section({
		name: "memory-loom:protocol",
		order: config.prompt.protocolOrder,
		text: () => rename(renderProtocol(engine.config)),
		interpolate: false
	});
	ctx.systemPrompt.section({
		name: "memory-loom:index-protocol",
		order: config.prompt.protocolOrder + 5,
		text: () => rename(renderIndexProtocol(config.locale)),
		interpolate: false
	});
	const agentDisposers = /* @__PURE__ */ new Map();
	ctx.effect(() => () => {
		for (const dispose of agentDisposers.values()) try {
			dispose();
		} catch {}
		agentDisposers.clear();
	}, "memory-loom:agents");
	const turns = /* @__PURE__ */ new Map();
	/**
	* 宿主不兜底 section/context 的 `text()`：这里抛一次，本轮 turn 就以 error 结束
	* （`dsh-agent-loop` 的 preStep → turn 的 catch → `turn/end: error`），下一次组装还会再抛。
	* 所以降级成空块：这一轮没有记忆，但对话继续。两个空块都会被宿主过滤掉
	* （`renderPrompt` / `renderContextSections` 都 filter(text.length > 0)），不会留下空标题。
	*
	* 但是空块没人看得见：模型不知道自己失忆，会照常答、甚至编。所以连续失败
	* PROMPT_NOTICE_AFTER 次之后，由 memory 块（三块里唯一每轮都会被求值的那块）吐一句
	* 状态说明，告诉模型别硬编、需要排查就调 memory_doctor。任一 label 成功即清零，
	* 库恢复后这句自动消失。
	*/
	const PROMPT_LABELS = ["persona", "hooks", "memory"];
	const PROMPT_NOTICE_AFTER = 3;
	const promptHealth = /* @__PURE__ */ new Map();
	const healthState = (sessionId) => {
		let state = promptHealth.get(sessionId);
		if (state === void 0) {
			state = {};
			promptHealth.set(sessionId, state);
		}
		return state;
	};
	const notePromptFailure = (sessionId, label, error) => {
		const state = healthState(sessionId);
		const prev = state[label];
		const now = Date.now();
		const entry = {
			count: (prev?.count ?? 0) + 1,
			at: now,
			error: clip(String(error?.message ?? error), 160),
			warnedAt: prev?.warnedAt ?? 0
		};
		state[label] = entry;
		if (now - entry.warnedAt > 6e4) {
			entry.warnedAt = now;
			logger.warn(`memory-loom: ${label} prompt failed ${entry.count} time(s) in a row: ${entry.error}`);
		}
	};
	const notePromptSuccess = (sessionId, label) => {
		const state = promptHealth.get(sessionId);
		if (state !== void 0 && state[label] !== void 0) delete state[label];
	};
	const failingBlocks = (sessionId) => {
		const state = promptHealth.get(sessionId);
		if (state === void 0) return [];
		return PROMPT_LABELS.filter((label) => (state[label]?.count ?? 0) >= PROMPT_NOTICE_AFTER).map((label) => ({
			label,
			...state[label]
		}));
	};
	const degradeNotice = (sessionId) => {
		const failing = failingBlocks(sessionId);
		if (failing.length === 0) return "";
		const worst = failing.reduce((a, b) => b.count > a.count ? b : a);
		const names = failing.map((row) => row.label).join("/");
		if (config.locale === "en") return `\n\n[Memory status] Memory reads failed ${worst.count} times in a row (${names}); this turn's memory is missing or incomplete (${worst.error}). Say plainly that memory is temporarily unavailable and do not fill the gap from imagination. Run memory_doctor to diagnose — not every turn.`;
		return `\n\n【记忆状态】记忆读取已连续失败 ${worst.count} 次（${names}），本轮的记忆内容缺失或不完整（${worst.error}）。请如实说明记忆暂时读不出来，不要凭印象编造；需要排查时可调用 memory_doctor，不必每轮都调。`;
	};
	/**
	* The offer: something on disk that this plugin has not read.
	*
	* Three constraints shape it. It has to name the file, because 「有一份可导入的
	* 记忆」 is a sentence nobody can answer. It has to hand the model the exact two
	* calls (预览 / 导入 / 拒绝), because the whole point is that the user decides and
	* the model's only job is to ask — a paragraph of explanation without a call
	* shape gets paraphrased into 「我已经导入了」. And it has to stop: a plugin that
	* re-asks every turn is a plugin people uninstall, so each session hears it at
	* most `INTAKE_NOTICE_TURNS` times and `memory_doctor` keeps reporting it after.
	*
	* Counted per turn, not per evaluation: the block is rendered on every step of
	* a turn, and counting renders would spend all three chances inside the first
	* reply.
	*/
	const intakeAsks = /* @__PURE__ */ new Map();
	const intakeNotice = (sessionId) => {
		let pending;
		try {
			/*
			* A file that could not be read is not a question anybody can answer
			* yet — it is either corrupt, still being written, or not a memory file
			* at all. It stays in `memory_doctor` so the curious can find it, but it
			* does not spend a turn asking about something with no count and no way
			* to say yes.
			*/
			pending = pendingIntake(engine.store).filter((entry) => entry.rows !== null);
		} catch {
			return "";
		}
		if (pending.length === 0) return "";
		const turn = turns.get(sessionId) ?? 0;
		const state = intakeAsks.get(sessionId) ?? {
			turn: -1,
			shown: 0,
			sig: ""
		};
		/*
		* A different pending set is a different question. Without this signature a
		* session that answered the first file would stay silent forever about a
		* second one that appeared an hour later — the count would still be spent.
		*/
		const sig = pending.map((entry) => `${entry.path}:${entry.bytes}:${entry.mtime}`).join("|");
		if (state.sig !== sig) {
			state.sig = sig;
			state.turn = turn;
			state.shown = 1;
			intakeAsks.set(sessionId, state);
		} else if (state.turn !== turn) {
			state.turn = turn;
			state.shown += 1;
		}
		if (state.shown > INTAKE_NOTICE_TURNS) return "";
		const detail = pending.map((entry, index) => `${index + 1}. ${intakeLabel(entry)}${entry.rows === null ? "" : ` ${entry.rows} 条`}`).join("；");
		// One file, one number: 说 source=1 才成立。多份时先让他自己数一遍，
		// 否则模型会把「第一份」当成「我要的那份」，导错文件比不导更糟。
		const example = pending.length === 1 ? "1" : "清单里的编号";
		if (config.locale === "en") return `\n\n[Importable memory] Another memory plugin left memory on this disk that this plugin has not read: ${detail}. Ask the user first whether to import it — do not decide for them, and do not pretend you have read the contents. If yes: memory_import(source=${example}) shows the list and the cost, then memory_import(source=${example}, confirm=true) after they confirm. If no: memory_import(source=${example}, dismiss=true), and never bring it up again.`;
		return `\n\n【可导入的记忆】磁盘上还有别的记忆插件留下的记忆没搬过来：${detail}。这不是本插件的数据，内容还没读进来。先问用户要不要导入（大意：「发现你以前装的记忆插件里还有这些记忆，要搬到现在这个记忆里吗？搬过来就能一起检索到」），不要自己决定，也不要假装已经读过里面的内容。用户说要：memory_import(source=${example}) 看清单和代价，他确认后再 memory_import(source=${example}, confirm=true)；用户说不用：memory_import(source=${example}, dismiss=true)，以后不再提。`;
	};
	const attachAgent = (agent) => {
		const sessionId = String(agent.id);
		if (agentDisposers.has(sessionId)) return;
		const guardPrompt = (label, fn) => () => {
			try {
				const text = fn();
				notePromptSuccess(sessionId, label);
				return rename(label === "memory" ? text + degradeNotice(sessionId) + intakeNotice(sessionId) : text);
			} catch (error) {
				notePromptFailure(sessionId, label, error);
				return rename(label === "memory" ? degradeNotice(sessionId).replace(/^\n+/u, "") : "");
			}
		};
		const disposers = [];
		try {
			disposers.push(agent.ctx.systemPrompt.section({
				name: `memory-loom:persona:${sessionId}`,
				order: config.prompt.personaOrder,
				text: guardPrompt("persona", () => engine.personaFor(engine.identityOf(sessionId).id)),
				interpolate: false
			}));
			disposers.push(agent.ctx.systemPrompt.context({
				name: `memory-loom:hooks:${sessionId}`,
				order: config.prompt.indexOrder,
				required: true,
				text: guardPrompt("hooks", () => {
					const identityId = engine.identityOf(sessionId).id;
					const has = engine.store.db.prepare("SELECT 1 AS hit FROM loom_hooks WHERE identity_id = ? AND resident = 1 LIMIT 1").get(identityId);
					if (has === void 0) indexStore.rebuild(identityId);
					return indexStore.render(identityId);
				}),
				interpolate: false
			}));
			disposers.push(agent.ctx.systemPrompt.context({
				name: `memory-loom:memory:${sessionId}`,
				order: config.prompt.memoryOrder,
				required: true,
				text: guardPrompt("memory", () => engine.recallFor(sessionId).text),
				interpolate: false
			}));
		} catch (error) {
			logger.warn(`could not attach memory prompt to session ${sessionId}: ${String(error)}`);
		}
		agentDisposers.set(sessionId, () => {
			for (const dispose of disposers) try {
				dispose();
			} catch {}
		});
	};
	ctx.on("agent/created", ({ agent }) => {
		attachAgent(agent);
	});
	/**
	* DSH composes plugins into a *running* process (live reconcile): `dsh plugin
	* add` appends the bundle, activates this layer and calls `apply()` without
	* restarting. Sessions that already exist will never emit `agent/created`
	* again, so their per-session blocks must be attached here — otherwise a
	* freshly installed plugin is invisible to the session it was installed in
	* until that session is reopened.
	*/
	(() => {
		let registry;
		try {
			registry = ctx.get("agents", false);
		} catch {
			return;
		}
		if (registry === undefined || typeof registry.list !== "function") return;
		try {
			for (const agent of registry.list()) attachAgent(agent);
		} catch (error) {
			logger.warn(`could not attach memory prompt to live sessions: ${String(error)}`);
		}
	})();
	ctx.on("agent/disposed", ({ agent }) => {
		const sessionId = String(agent.id);
		agentDisposers.get(sessionId)?.();
		agentDisposers.delete(sessionId);
		turns.delete(sessionId);
		promptHealth.delete(sessionId);
		intakeAsks.delete(sessionId);
	});
	ctx.on("session/event", (session, event) => {
		const sessionId = String(session.id);
		const kind = event.type;
		try {
			if (event.type === "turn/start") {
				turns.set(sessionId, event.data.turn);
				return;
			}
			if (event.type === "request/context") {
				const data = event.data;
				engine.noteRoute(sessionId, data.provider, data.model);
				return;
			}
			if (kind === "compaction/start") {
				engine.emergencyFlush();
				return;
			}
			if (!config.capture) return;
			if (event.type === "user/message") {
				const message = event.data;
				if (message.source?.kind !== "user") return;
				const text = textOf(message.content);
				if (text.length === 0) return;
				engine.recordMessage({
					sessionId,
					turn: turns.get(sessionId) ?? 0,
					role: "user",
					text,
					timezone,
					createdAt: event.time
				});
				return;
			}
			if (event.type === "assistant/message") {
				const data = event.data;
				const text = textOf(data.message.content);
				if (text.length === 0) return;
				engine.recordMessage({
					sessionId,
					turn: data.turn,
					role: "assistant",
					text,
					timezone,
					createdAt: event.time
				});
			}
		} catch (error) {
			logger.warn(`capture failed for ${sessionId}/${event.type}: ${String(error)}`);
		}
	});
	let ticking = false;
	let lastIndexRebuild = 0;
	let lastDiaryError = null;
	/** Day (YYYY-MM-DD) the budget warning was last written, so it prints once. */
	let budgetWarnedOn = "";
	const tick = async () => {
		if (closed || ticking) return;
		ticking = true;
		try {
			engine.maintain();
			/*
			* 装好之后先看一眼周围有没有别人的记忆文件。放在维护里而不是只放在 apply() 里，
			* 是因为「装好」这个时刻经常不是「用上」这个时刻：用户可能装完就关了 DSH，
			* 三天后才第一次打开；也可能装完继续用，而那之后另一个插件又写了新记忆。
			* 6 小时一次足够 —— 这不是一个会自我变化的事实。
			*/
			refreshIntake(config, engine.store);
			/*
			* Rolling snapshot. The store is a single plaintext file with no replica,
			* and "make a backup yourself" is advice nobody follows — losing it means
			* losing every memory at once. One copy per `backup.everyHours`, newest
			* `backup.keep` kept, skipped while the store is still empty.
			*/
			if (config.backup.enabled) try {
				const dir = backupDirFor(config.path, config.backup.dir);
				const content = asNumber(engine.store.db.prepare("SELECT (SELECT COUNT(*) FROM l0) + (SELECT COUNT(*) FROM facts) + (SELECT COUNT(*) FROM events) AS n").get()["n"]);
				const written = snapshotStore({
					db: engine.store.db,
					dir,
					now: engine.now(),
					timezone,
					everyHours: config.backup.everyHours,
					hasContent: content > 0
				});
				if (written !== null) {
					const dropped = pruneSnapshots(dir, config.backup.keep);
					logger.info(`memory-loom: snapshot ${written}${dropped.length > 0 ? ` (pruned ${dropped.length})` : ""}`);
				}
			} catch (error) {
				logger.warn(`memory-loom: snapshot failed: ${String(error)}`);
			}
			if (config.index.rebuildMinutes > 0 && Date.now() - lastIndexRebuild >= config.index.rebuildMinutes * 60000) {
				lastIndexRebuild = Date.now();
				try {
					for (const row of engine.store.db.prepare("SELECT DISTINCT identity_id FROM loom_hooks").all()) indexStore.rebuild(row.identity_id);
				} catch (error) {
					logger.warn(`index rebuild failed: ${String(error)}`);
				}
			}
			// `consolidation.enabled = false` skips every model-backed step but keeps
			// capture, maintenance and the hook index running: L0 still lands on disk
			// and the `T` tail still covers it.
			if (config.consolidation.enabled) for (const session of engine.dueSessions()) try {
				const report = await engine.consolidate(session.sessionId);
				/*
				* 每天第一次因配额降级时写一条 warn，之后不再重复。
				*
				* 一次批量整合会让每一段都降级，逐段打日志等于把真正的问题埋进
				* 日志洪水；而一条都不写，用户只能靠「它好像变笨了」这种几周后才
				* 形成的感觉，去猜预算早就用光了。一天一条，够查，不吵。
				*/
				if (asNumber$1(report?.degradeReasons?.["budget"]) > 0) {
					let day = "";
					try {
						day = dayKey(engine.now(), engine.timezoneOf(session.sessionId));
					} catch {
						day = dayKey(engine.now(), null);
					}
					if (day !== budgetWarnedOn) {
						budgetWarnedOn = day;
						logger.warn("memory-loom: 今日模型配额已用尽（consolidation.dailyLlmCalls），后续对话只走规则抽取——原话仍会入库，但抽不出压缩后的事实，之后更难被搜到。明天零点恢复，也可以调大该配置。memory_doctor 能看到当前用量。");
					}
				}
			} catch (error) {
				logger.warn(`consolidation failed for ${session.sessionId}: ${String(error)}`);
			}
			// Diary entries are written during consolidation, so the readable mirror
			// is refreshed right after it — never inside the transaction path.
			engine.syncDiary(2);
			const diaryError = engine.diaryMirror.error;
			if (diaryError !== null && diaryError !== lastDiaryError) {
				lastDiaryError = diaryError;
				logger.warn(`diary mirror failed (entries stay in the database): ${diaryError}`);
			}
		} catch (error) {
			logger.warn(`maintenance failed: ${String(error)}`);
		} finally {
			ticking = false;
		}
	};
	ctx.on("agent/turn-stopping", ({ agent }) => {
		const sessionId = String(agent.id);
		/** Fallback for hosts that expose no `agents` registry: attach on next turn. */
		if (!agentDisposers.has(sessionId)) attachAgent(agent);
		let due = false;
		try {
			due = engine.completeTurn(sessionId);
		} catch (error) {
			logger.warn(`turn close failed for ${sessionId}: ${String(error)}`);
			return;
		}
		if (due) tick();
	});
	ctx.effect(() => {
		const timer = setInterval(() => {
			tick();
		}, config.maintenanceIntervalSeconds * 1e3);
		timer.unref?.();
		return () => clearInterval(timer);
	}, "memory-loom:maintenance");
	/*
	* 装好就先检查一遍。这是用户第一次打开对话之前唯一的一次机会 —— 错过了，那份
	* 记忆就要等到六小时后的维护才被看见，而用户可能那天就再没打开过。
	* 失败只记一行日志：扫不到别人的文件，不影响本插件自己的工作。
	*/
	try {
		const pending = refreshIntake(config, engine.store, {
			force: true,
			now: engine.now()
		});
		if (pending.length > 0) logger.info(`memory-loom: found ${pending.length} memory file(s) from another plugin (${pending.map((entry) => basename(entry.path)).join(", ")}) — offered, not imported`);
	} catch (error) {
		logger.warn(`memory-loom: scanning for other plugins' memory files failed: ${String(error?.message ?? error)}`);
	}
	registerTools(ctx, {
		engine,
		config,
		index: indexStore,
		health: promptHealth
	});
	logger.info(`memory store open at ${config.path}`);
	if (!config.consolidation.enabled) logger.info("memory-loom: consolidation is disabled (consolidation.enabled=false); raw turns are still captured");
}

//#endregion
export { Config, apply, inject, name, HookIndex, indexDefaults, estimateTokens, parseRef, parseDue, sliceByTokens };