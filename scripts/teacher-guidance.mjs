/**
 * Teacher-only guidance for collecting RICHER code-model training data.
 *
 * VibeCoder's own coder prompt stays exactly as it is. Only the teacher's
 * request gets one extra line saying what a finished file of its domain looks
 * like - a usable page, complete routes, a seeded table. The training record
 * keeps the plain request (capture-code-batch.mjs rebuilds it with a recording
 * stub), so the small model learns to write the rich file from the request it
 * will really see, without being told.
 *
 * Tried first as a prompt change for the small model itself (2026-10-19): it
 * failed the build in 3 of 3 library runs, each time on whatever was new to it.
 * A 30B teacher plus the build/verify filter is where this text belongs.
 */
export const TEACHER_GUIDANCE = {
  frontend:
    'a page a person can actually use, that looks finished on a phone and on a laptop. For each listed endpoint the purpose of this ' +
    'page covers, give the user a way to use it: show GET results as a list or table (cards on narrow screens), a form with ' +
    'labelled inputs and a submit button for each POST or PUT, and a button for each action on a row (for example Return or ' +
    'Delete). After a change succeeds, load the data again. Check response.ok; show "Loading..." while loading, a short friendly ' +
    'message when there is nothing to show, and the error text when a request fails. Style it with inline style objects only - a ' +
    'centred column with max-width, spacing, a readable system font, rounded cards or a bordered table, clear primary buttons, ' +
    'inputs at full width, flexWrap so rows wrap on small screens - no CSS files and no new packages. Import every React hook ' +
    'you use by name (import { useEffect, useState } from "react"); never write React.useState.',
  backend:
    'routes a working app needs for its purpose: list, get one by id, create (POST), update (PUT) and delete, plus every action ' +
    'the purpose names, each calling the database functions you are given. Check the request body and answer 400 with a short ' +
    'JSON message when it is wrong, 404 when a row does not exist, 201 with the created row for a create, and JSON on success.',
  database:
    'a table with exported functions to list all rows, get one by id, insert, update and delete. An insert returns the new id ' +
    'from the result of run(), never from the statement: return Number(db.prepare(sql).run(...values).lastInsertRowid). A get by ' +
    'id returns the row or undefined: return db.prepare(sql).get(id) as Row | undefined. At the end of the file, when the list ' +
    'function returns no rows, call your own insert function 3 to 5 times with realistic sample values, so the app shows ' +
    'real-looking data the first time it runs.',
};

/** The domain a coder request is for, read from its own "Domain: <name>" line. */
export function requestDomain(user) {
  return /^Domain: (\w+)$/m.exec(user)?.[1];
}

/** Wraps the teacher provider so each code request carries its domain's guidance; everything else passes through. */
export function withTeacherGuidance(provider) {
  return {
    ...provider,
    complete(request) {
      const guidance = TEACHER_GUIDANCE[requestDomain(request.user) ?? ''];
      if (guidance === undefined) return provider.complete(request);
      return provider.complete({ ...request, user: `${request.user}\nWhat a finished file of this domain looks like: ${guidance}` });
    },
  };
}
