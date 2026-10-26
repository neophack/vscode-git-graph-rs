/* Date formatting. Every formatter takes the configured date format explicitly (the configuration
   can change while the view is open); the interface language comes from the active string table.
   All locale-dependent pieces - the month tokens, the placement of day / month / year, and the
   relative-time words - live in the shared dictionary (dateMonthsShort, date*Date,
   dateRelative*), so this module holds no literals of its own. */

import { formatStr, getInterfaceLanguage, strings } from './i18n/index';
import * as GG from './protocol';

/** Pad a number with a leading zero to at least two digits. */
export function pad2(i: number) {
	return i > 9 ? String(i) : '0' + i;
}

/**
 * Format a date (short), as the commit table shows it.
 * @param unixTimestamp The unix timestamp of the date.
 * @param format The configured date format.
 * @returns The full date and time (`title`), and the date in the configured format (`formatted`).
 */
export function formatShortDate(unixTimestamp: number, format: GG.DateFormat) {
	const date = new Date(unixTimestamp * 1000);
	const dateStr = format.iso
		? date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
		: formatStr(strings.dateFullDate, String(date.getDate()), strings.dateMonthsShort[date.getMonth()], String(date.getFullYear()));
	const hourMinsStr = pad2(date.getHours()) + ':' + pad2(date.getMinutes());
	let formatted;

	if (format.type === GG.DateFormatType.DateAndTime) {
		formatted = dateStr + ' ' + hourMinsStr;
	} else if (format.type === GG.DateFormatType.DateOnly) {
		formatted = dateStr;
	} else {
		let diff = Math.round((new Date()).getTime() / 1000) - unixTimestamp, unit;
		// A commit dated in the future (author date set forward, a rebase preserving it, or clock
		// skew between machines) must not render as a negative "seconds ago": clamp it to now.
		if (diff < 0) diff = 0;
		if (diff < 60) {
			unit = 'second';
		} else if (diff < 3600) {
			unit = 'minute';
			diff /= 60;
		} else if (diff < 86400) {
			unit = 'hour';
			diff /= 3600;
		} else if (diff < 604800) {
			unit = 'day';
			diff /= 86400;
		} else if (diff < 2629800) {
			unit = 'week';
			diff /= 604800;
		} else if (diff < 31557600) {
			unit = 'month';
			diff /= 2629800;
		} else {
			unit = 'year';
			diff /= 31557600;
		}
		diff = Math.round(diff);
		const units: { [unit: string]: string } = strings.dateRelativeUnits;
		// English pluralises the unit ("2 seconds ago"); the Chinese suffix is empty.
		const unitWord = units[unit] + (diff !== 1 ? strings.dateRelativePluralSuffix : '');
		formatted = formatStr(strings.dateRelativeAgo, String(diff), unitWord);
	}
	return {
		title: dateStr + ' ' + hourMinsStr + ':' + pad2(date.getSeconds()),
		formatted: formatted
	};
}

/**
 * Format a date (long), as the Commit Details View shows it.
 * @param unixTimestamp The unix timestamp of the date.
 * @param format The configured date format.
 */
export function formatLongDate(unixTimestamp: number, format: GG.DateFormat) {
	const date = new Date(unixTimestamp * 1000);
	if (format.iso) {
		const timezoneOffset = date.getTimezoneOffset();
		const absoluteTimezoneOffset = Math.abs(timezoneOffset);
		const timezone = timezoneOffset === 0 ? 'Z' : ' ' + (timezoneOffset < 0 ? '+' : '-') + pad2(Math.floor(absoluteTimezoneOffset / 60)) + pad2(absoluteTimezoneOffset % 60);
		return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds()) + timezone;
	} else if (getInterfaceLanguage() === 'zh-cn') {
		return formatStr(strings.dateFullDate, String(date.getDate()), strings.dateMonthsShort[date.getMonth()], String(date.getFullYear())) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
	} else {
		return date.toString();
	}
}

/**
 * A calendar day for the mobile layout: "Oct 9" / "10月9日" / "10-09", with the year when
 * `withYear` is set ("Oct 9, 2024" / "2024年10月9日" / "2024-10-09").
 */
export function formatDayDate(unixTimestamp: number, withYear: boolean, format: GG.DateFormat) {
	const date = new Date(unixTimestamp * 1000), year = date.getFullYear(), month = date.getMonth() + 1, day = date.getDate();
	if (format.iso) return (withYear ? year + '-' : '') + pad2(month) + '-' + pad2(day);
	const monthToken = strings.dateMonthsShort[month - 1];
	return withYear
		? formatStr(strings.dateDayDateWithYear, String(day), monthToken, String(year))
		: formatStr(strings.dateDayDate, String(day), monthToken);
}

/**
 * The date of a commit row in the mobile layout, as short as a mail list's: the time for today,
 * "Yesterday", the weekday within the last week, else the day (with the year when it isn't this one).
 */
export function formatCompactDate(unixTimestamp: number, format: GG.DateFormat) {
	const date = new Date(unixTimestamp * 1000), now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), time = date.getTime();
	if (time >= startOfToday && time < startOfToday + 86400000) return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
	if (time >= startOfToday - 86400000 && time < startOfToday) return strings.mobileYesterday;
	if (time >= startOfToday - 6 * 86400000 && time < startOfToday) return strings.mobileWeekdays[date.getDay()];
	return formatDayDate(unixTimestamp, date.getFullYear() !== now.getFullYear(), format);
}

/** The day and time of a commit in the mobile Commit Details sheet: "Oct 9, 2025 16:32". */
export function formatMediumDate(unixTimestamp: number, format: GG.DateFormat) {
	const date = new Date(unixTimestamp * 1000);
	return formatDayDate(unixTimestamp, true, format) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}
