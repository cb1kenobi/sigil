/**
 * What can be wrong with each value, as plain functions of the values.
 *
 * Kept apart from the screen so the rules are tested as rules, without a
 * terminal. Each answers in words a person reads under the field, so it says
 * what to do rather than what failed.
 */

import type { Settings } from './account.ts';
import type { Check } from './form.ts';

/** What the login form edits. */
export interface Login {
  password: string;
  user: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d ]+$/;
const USER = /^[\w.-]+$/;

/** The shortest password the form lets through. */
export const MIN_PASSWORD = 8;

/** The longest display name. */
export const MAX_NAME = 40;

/** The settings screen's checks. Only the profile's three text fields can be wrong. */
export const SETTINGS_CHECKS: { readonly [K in keyof Settings]?: Check<Settings, K> } = {
  email: (email) => {
    if (email.trim() === '') {
      return 'Enter an email address';
    }
    return EMAIL.test(email.trim()) ? undefined : 'Enter an address like name@example.com';
  },
  name: (name) => {
    if (name.trim() === '') {
      return 'Enter a display name';
    }
    return name.length > MAX_NAME ? `Keep it to ${MAX_NAME} characters` : undefined;
  },
  // a check that reads another field: the number is optional until SMS is ticked
  phone: (phone, { sms }) => {
    if (phone.trim() === '') {
      return sms ? 'SMS needs a phone number' : undefined;
    }
    return PHONE.test(phone.trim()) && phone.replace(/\D/g, '').length >= 7
      ? undefined
      : 'Use digits and spaces, with + for a country code';
  },
};

/** The login form's checks. */
export const LOGIN_CHECKS: { readonly [K in keyof Login]?: Check<Login, K> } = {
  password: (password) => {
    if (password === '') {
      return 'Enter your password';
    }
    return password.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters` : undefined;
  },
  user: (user) => {
    if (user.trim() === '') {
      return 'Enter your user name';
    }
    return USER.test(user.trim()) ? undefined : 'Only letters, digits and . _ -';
  },
};
