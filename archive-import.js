/**
 * Archive File Uploader + Smart Parser
 * Upload old exam/lecture files (.docx, .pdf, .txt, .md, .csv, .json),
 * pull out the cover info + questions, and load them into the editor.
 *
 * Relies on globals from app.js: examData, resequenceQuestionNumbers, saveData,
 * renderEditor, renderPreview, openBulkModal, closeBulkModal
 * NOTE: this file defines parseRawQuestions() and overrides the basic one in app.js.
 */

// ==========================================================================
// Smart question parser
// ==========================================================================
const Q_RE = /^(\d{1,3})\s*[\.\)\-:]\s*(?!\d)(.*)$/;
// Accept the arrow/bullet marker produced by pasted text or OCR (for example: » Which ...).
const BULLET_Q_RE = /^(?:»|>|•|▪|◦)\s*(.+)$/;
// Accept both conventional choices (a. / a)) and OCR output without punctuation (a Choice).
const LETTER_RE = /^([a-fA-F])(?:\s*[\.\)]\s*|\s+)(.+)$/;
const ANS_RE = /^(?:answer|ans)\b\s*[:\-\.]?\s*(.*)$/i;
// A tick after a choice marks the right answer ("B. Antidote ✅"), e.g. from screenshots
const TICK_RE = /\s*[✅✔✓☑]\uFE0F?\s*/g;
const hasTick = (s) => /[✅✔✓☑]/.test(s);
// A line that reads as a question on its own ("Caused by?", "شو اسمها؟", "True statements:")
const QUESTION_END_RE = /[?؟:]\s*[|)\]}]*\s*$/;
// Written between screenshot boxes by the OCR reader (a big empty gap in the picture).
// In text without question numbers it separates questions.
const SEP_RE = /^-{3,}$/;

// A cover page found in the middle of an uploaded PDF is represented in the text as
// [[COVER:id]]; the page image lives in window.pendingCoverPages[id].
const COVER_MARK_RE = /^\[\[COVER:([\w-]+)\]\]$/;
window.pendingCoverPages = window.pendingCoverPages || {};

function makeCoverItem(id, c) {
  return {
    id: "cv" + id,
    type: "cover",
    image: c.image || "",
    label: c.label || "Cover page",
    // editable cover fields (same design as the first cover page)
    subject: c.subject || "",
    archive: c.archive || "Archive",
    lecture: c.lecture || "",
    topic: c.topic || "",
    collectedBy: c.collectedBy || "",
    editedBy: c.editedBy || "",
    correctedBy: c.correctedBy || "",
    primaryColor: c.primaryColor || "",
    // "scan" = a picture-only page from a PDF (screenshots): always shown as the picture
    kind: c.kind || "",
    // false = rebuilt from the fields above (editable); true = original PDF image
    useImage: !!(c.useImage && c.image),
    number: "",
    question: "",
    tag: "",
    pageBreakAfter: false,
    choices: [],
    answer: "",
    answerPrefix: "",
    sideNote: "",
  };
}

function cleanLine(l) {
  return String(l)
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/\u201a/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

// "brith Answer:b" -> ["brith", "Answer:b"]
function splitInlineAnswer(line) {
  if (/^(?:answer|ans)\b/i.test(line)) return [line];
  const m = line.match(/^(.*\S)\s+((?:answer|ans)\s*[:\-]\s*\S.*)$/i);
  return m ? [m[1], m[2]] : [line];
}

function buildQuestion(c, idx) {
  let tag = "";
  const lines = c.lines
    .map((l) => {
      if (l.includes("مهم")) {
        tag = "مهم";
        return l.replace(/\(?مهم\)?/g, "").trim();
      }
      return l.trim();
    })
    .filter(Boolean);

  let question = "";
  let answer = c.answer;
  let type;

  if (c.choices.length) {
    type = "mcq";
    question = lines.join(" ");
  } else {
    type = "direct";
    if (answer || c.loose) {
      question = lines.join(" ");
    } else if (lines.length >= 2) {
      if (/[?:]$/.test(lines[0])) {
        question = lines[0];
        answer = lines.slice(1).join(" ");
      } else {
        // last line is the (red) answer, earlier lines are the wrapped question
        question = lines.slice(0, -1).join(" ");
        answer = lines[lines.length - 1];
      }
    } else {
      question = lines[0] || "";
    }
  }

  // Options without letters, one marked with a tick (common in screenshots):
  // "Caused by?" / "Non rifled weapon ✅" / "rifled weapon" -> MCQ a/b/...
  if (type === "direct" && !c.answer && lines.length >= 3 && lines.length <= 8 && lines.slice(1).some(hasTick)) {
    type = "mcq";
    question = lines[0];
    answer = "";
    c.choices = lines.slice(1).map((l, i) => {
      const label = String.fromCharCode(97 + i);
      if (hasTick(l)) answer = label.toUpperCase();
      return { label: label, text: l.replace(TICK_RE, " ").trim() };
    });
  }

  return {
    id: "q" + Date.now() + Math.random().toString(36).slice(2, 6) + idx,
    number: String(c.num),
    type: type,
    question: question,
    tag: tag,
    pageBreakAfter: false,
    choices: c.choices.map((ch) => ({ label: ch.label, text: ch.text })),
    answer: answer || "",
    answerPrefix: type === "mcq" ? c.prefix : "",
    sideNote: (c.notes || []).join(" "),
  };
}

function parseRawQuestions(text) {
  const lines = String(text).replace(/\r/g, "").split("\n").map(cleanLine).filter(Boolean);
  const out = [];
  let cur = null;
  let lastNum = 0;

  const flush = () => {
    if (cur) out.push(buildQuestion(cur, out.length));
    cur = null;
  };

  // "Loose" mode only for parts (between page markers) that have no numbered questions,
  // e.g. text read from screenshots: there, unnumbered lines start questions.
  // Normal numbered documents are parsed exactly as before.
  const looseAt = [];
  {
    let start = 0;
    const mark = (end) => {
      const numbered = lines.slice(start, end).filter((l) => Q_RE.test(l)).length >= 2;
      for (let k = start; k < end; k++) looseAt[k] = !numbered;
    };
    lines.forEach((l, k) => {
      if (COVER_MARK_RE.test(l)) {
        mark(k);
        start = k + 1;
      }
    });
    mark(lines.length);
  }

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const loose = !!looseAt[li];
    if (SEP_RE.test(raw)) {
      // new box: the next text line starts a new question, but options that continue
      // the open question (its options sit in their own box) still belong to it
      if (loose && cur) cur.boxEnded = true;
      continue;
    }
    // 0) Cover-page marker (inserted when a PDF is read): keep the cover in position
    const cm = raw.match(COVER_MARK_RE);
    if (cm) {
      flush();
      const c = (window.pendingCoverPages || {})[cm[1]];
      // a real cover starts a new lecture (numbering restarts); a picture page does not
      if (!c || c.kind !== "scan") lastNum = 0;
      if (c) out.push(makeCoverItem(cm[1], c));
      continue;
    }

    for (let line of splitInlineAnswer(raw)) {
      // OCR reads "B." as "8." - fix it when it can only be option B (right after option A)
      const lastLbl = cur && cur.choices.length ? cur.choices[cur.choices.length - 1].label : "";
      if (loose && lastLbl === "a") line = line.replace(/^8\s*([.)])\s*/, "B$1 ");

      // 0) Arrow/bullet question marker (common in pasted notes and OCR).
      // Start a new question and assign the next available number automatically.
      let qm = line.match(BULLET_Q_RE);
      if (qm) {
        flush();
        lastNum += 1;
        cur = { num: lastNum, lines: [qm[1].trim()], choices: [], answer: "", prefix: "Ans: " };
        continue;
      }

      // 1) Answer line
      let m = line.match(ANS_RE);
      if (m && cur && m[1].trim()) {
        cur.answer = m[1].trim();
        cur.prefix = /^answer/i.test(line) ? "Answer: " : "Ans: ";
        continue;
      }

      // 2) Numbered line: new question OR numeric choice (1. 2. 3. 4.)
      m = line.match(Q_RE);
      if (m) {
        const n = parseInt(m[1], 10);
        const last = cur && cur.choices.length ? cur.choices[cur.choices.length - 1] : null;
        const lastChoiceNum = last && /^\d+$/.test(last.label) ? parseInt(last.label, 10) : 0;
        const isNumChoice =
          cur &&
          n !== lastNum + 1 &&
          ((cur.choices.length === 0 && n === 1) || (lastChoiceNum && n === lastChoiceNum + 1));

        if (isNumChoice) {
          cur.choices.push({ label: String(n), text: m[2].trim() });
        } else {
          flush();
          const rest = m[2].trim();
          // Some copied/OCR text puts the first option on the same line as the question:
          // "3. flavour: a. Taste alone". Split it so the option keeps MCQ styling.
          const inlineChoice = rest.match(/^(.*?)(?:\s+)([a-fA-F])\s*[.)]\s+(.+)$/);
          if (inlineChoice && /[?:]$/.test(inlineChoice[1].trim())) {
            cur = {
              num: n,
              lines: [inlineChoice[1].trim()],
              choices: [{ label: inlineChoice[2].toLowerCase(), text: inlineChoice[3].trim() }],
              answer: "",
              prefix: "Ans: "
            };
          } else {
            cur = { num: n, lines: [rest], choices: [], answer: "", prefix: "Ans: " };
          }
          lastNum = n;
        }
        continue;
      }

      // 3) Letter choice (A) / a. / B.)
      // Word/PDF extraction may leave a decorative bullet before the first choice.
      const choiceLine = line.replace(/^[·•▪◦]\s*/, "");
      m = choiceLine.match(LETTER_RE);
      // With OCR, punctuation is often lost ("a Choice"). Only treat the
      // no-punctuation form as a choice when the choice text starts clearly,
      // while still allowing conventional "a. text" with any capitalization.
      const conventionalChoice = /^[a-fA-F]\s*[.)]/.test(choiceLine);
      const ocrChoice = m && /^[A-Z0-9]/.test(m[2]);
      if ((cur || loose) && m && (conventionalChoice || ocrChoice)) {
        const label = m[1].toLowerCase();
        // Options start again at "a" with no question number in between: a new
        // unnumbered question. The lines after the last option are its question text.
        if (loose && cur && cur.boxEnded) {
          const lastL = cur.choices.length ? cur.choices[cur.choices.length - 1].label : "";
          if (label > lastL && (cur.choices.length || cur.lines.length)) cur.boxEnded = false;
          else flush();
        }
        if (loose && !cur) {
          // options with no question text before them (it was cut off in the screenshot)
          lastNum += 1;
          cur = { num: lastNum, lines: [], choices: [], answer: "", prefix: "Ans: ", loose: true };
        } else if (loose && cur.choices.length && label <= cur.choices[cur.choices.length - 1].label) {
          const stem = cur.tail || [];
          if (stem.length) {
            const lc = cur.choices[cur.choices.length - 1];
            lc.text = lc.baseText;
          }
          flush();
          lastNum += 1;
          cur = { num: lastNum, lines: stem, choices: [], answer: "", prefix: "Ans: ", loose: true };
        }
        let text = m[2].trim();
        if (hasTick(text)) {
          text = text.replace(TICK_RE, " ").trim();
          cur.answer = label.toUpperCase();
        }
        cur.choices.push({ label: label, text: text });
        cur.tail = [];
        continue;
      }

      // 4) Text with no question number (screenshots / OCR / loose notes)
      const t = line.replace(/^[\.\s]+/, "");
      if (!t) continue;
      if (!cur && !loose) continue;
      const newQ =
        !cur ||
        (loose && cur.boxEnded) ||
        (loose && QUESTION_END_RE.test(t) && !hasTick(t) &&
          (cur.choices.length || cur.lines.some((l) => /[?؟]/.test(l))));
      if (newQ) {
        // no question open yet, or this line reads as the next question
        flush();
        lastNum += 1;
        cur = { num: lastNum, lines: [t], choices: [], answer: "", prefix: "Ans: ", loose: loose };
        continue;
      }
      // Arabic remark after English options ("الباقي مو متذكرته") -> side note
      if (loose && cur.choices.length && /[\u0600-\u06FF]/.test(t) &&
          !/[\u0600-\u06FF]/.test(cur.choices[cur.choices.length - 1].text)) {
        (cur.notes = cur.notes || []).push(t.replace(TICK_RE, " ").trim());
        continue;
      }
      // Wrapped continuation line
      if (cur.choices.length) {
        const lc = cur.choices[cur.choices.length - 1];
        if (!cur.tail || !cur.tail.length) lc.baseText = lc.text;
        (cur.tail = cur.tail || []).push(t);
        lc.text = (lc.text + " " + t).trim();
      } else {
        cur.lines.push(t);
      }
    }
  }
  flush();
  return out;
}

// ==========================================================================
// File readers
// ==========================================================================
(function () {
  const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  function ext(name) {
    return (name.split(".").pop() || "").toLowerCase();
  }

  function setStatus(msg, isError) {
    const el = document.getElementById("archiveStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.style.color = isError ? "#b91c1c" : "#0369a1";
  }

  // Turn pdf.js text items into properly ordered visual lines
  function pageToLines(items) {
    const its = items
      .filter((i) => i.str && i.str.length)
      .map((i) => ({
        s: i.str,
        x: i.transform[4],
        y: i.transform[5],
        w: i.width || 0,
        h: Math.abs(i.transform[3]) || i.height || 10,
      }));
    its.sort((a, b) => b.y - a.y || a.x - b.x);

    const groups = [];
    let cur = null;
    its.forEach((it) => {
      if (!cur || Math.abs(cur.y - it.y) > Math.max(3, it.h * 0.5)) {
        cur = { y: it.y, items: [it] };
        groups.push(cur);
      } else {
        cur.items.push(it);
      }
    });

    // Keep each line's font height and position next to it (lines.meta[i]) so a
    // cover title that wraps inside its box ("Forensic" / "medicine") can be rejoined.
    const lines = [];
    lines.meta = [];
    groups.forEach((g) => {
      g.items.sort((a, b) => a.x - b.x);
      let s = "";
      let prevEnd = null;
      let h = 0;
      g.items.forEach((it) => {
        if (prevEnd !== null) {
          const gap = it.x - prevEnd;
          if (gap > it.h * 0.25 && !s.endsWith(" ") && !it.s.startsWith(" ")) s += " ";
        }
        s += it.s;
        prevEnd = it.x + it.w;
        h = Math.max(h, it.h);
      });
      s = s.replace(/\s+/g, " ").trim();
      if (!s) return;
      lines.push(s);
      lines.meta.push({ y: g.y, h: h });
    });
    return lines;
  }

  // "Lecture 3", "Lec 2", "Group - D+c" ... the line shown in the lecture slot of the cover
  const LECTURE_LINE_RE = /^(?:(?:lecture|lec\.?)\s*[-:–]?\s*\d|group\b\s*[-:–]?\s*\S)/i;

  function parseCover(lines) {
    const meta = lines.meta || [];
    const info = { subject: "" };
    const used = new Set(); // line indexes that are NOT part of the topic
    lines.forEach((l, i) => {
      let m;
      if (/^archive$/i.test(l)) {
        info.archive = l;
        used.add(i);
      } else if (!info.lecture && LECTURE_LINE_RE.test(l)) {
        info.lecture = l;
        used.add(i);
      } else if ((m = l.match(/^collected\s*by\s*:?\s*(.*)$/i))) {
        info.collectedBy = m[1] || lines[i + 1] || "";
        used.add(i);
        if (!m[1]) used.add(i + 1);
      } else if ((m = l.match(/^(?:edit(?:ed|e)?|done)\s*by\s*:?\s*(.*)$/i))) {
        info.editedBy = m[1] || lines[i + 1] || "";
        used.add(i);
        if (!m[1]) used.add(i + 1);
      } else if ((m = l.match(/^corrected\s*by\s*:?\s*(.*)$/i))) {
        info.correctedBy = m[1] || lines[i + 1] || "";
        used.add(i);
        if (!m[1]) used.add(i + 1);
      }
    });

    // Subject = first remaining line (the "Archive" badge is no longer mistaken for it),
    // plus the next lines in the same font size right below it (a title wrapped in its box).
    const s = lines.findIndex((_, i) => !used.has(i));
    if (s !== -1) {
      const parts = [lines[s]];
      used.add(s);
      for (let j = s + 1; j < lines.length && !used.has(j); j++) {
        const a = meta[j - 1], b = meta[j];
        if (!a || !b || !a.h || !b.h) break;
        const sameSize = Math.abs(a.h - b.h) <= a.h * 0.08;
        const close = Math.abs(a.y - b.y) <= a.h * 1.8;
        if (!sameSize || !close) break;
        parts.push(lines[j]);
        used.add(j);
      }
      info.subject = parts.join(" ");
    }

    info.topic = lines.filter((_, i) => !used.has(i)).join("\n");
    return info;
  }

  // A cover page: has "Lecture N" plus an "Archive" badge or a "... by <name>" credit,
  // and none of the things a question page has (numbered question, options, answer).
  function isCoverLines(lines) {
    const hasLecture = lines.some((l) => LECTURE_LINE_RE.test(l));
    const hasArchive = lines.some((l) => /^archive\b/i.test(l));
    const hasCredit = lines.some((l) => /\b(?:edit(?:ed|e)?|collected|done|corrected)\s*by\b/i.test(l));
    const hasQ = lines.some((l) => Q_RE.test(l));
    const hasAns = lines.some((l) => ANS_RE.test(l));
    const hasChoice = lines.some((l) => LETTER_RE.test(l));
    return hasLecture && (hasArchive || hasCredit) && !hasQ && !hasAns && !hasChoice;
  }

  // Most common strongly-coloured pixel colour (e.g. the yellow/cyan cover blocks) as #rrggbb
  function dominantAccent(canvas) {
    try {
      const w = 120;
      const h = Math.max(1, Math.round((canvas.height * w) / canvas.width));
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.drawImage(canvas, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      const buckets = {};
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx - mn < 70 || mx < 120) continue; // skip white / grey / dark pixels
        const k = (r >> 4) + "," + (g >> 4) + "," + (b >> 4);
        const e = buckets[k] || (buckets[k] = { n: 0, r: 0, g: 0, b: 0 });
        e.n++; e.r += r; e.g += g; e.b += b;
      }
      let best = null;
      for (const k in buckets) if (!best || buckets[k].n > best.n) best = buckets[k];
      if (!best || best.n < 20) return "";
      const hx = (v) => Math.round(v / best.n).toString(16).padStart(2, "0");
      return "#" + hx(best.r) + hx(best.g) + hx(best.b);
    } catch (e) {
      return "";
    }
  }

  // Draw a PDF page to a JPEG data URL so it can be kept exactly as it looks
  async function renderPageImage(page) {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 1100 / base.width);
    const viewport = page.getViewport({ scale: scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
    return { image: canvas.toDataURL("image/jpeg", 0.85), accent: dominantAccent(canvas) };
  }

  // wantSettingsCover: true  -> a cover on page 1 fills the app's own cover page (old behaviour)
  //                    false -> a cover on page 1 is inserted like any other cover
  // Every other cover page found inside the PDF is inserted in position, as an image.
  async function readPdf(file, wantSettingsCover) {
    if (typeof pdfjsLib === "undefined") {
      throw new Error("PDF reader library did not load (check your internet connection).");
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

    const pages = [];
    let scannedPages = 0;
    const ocrErrors = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      let lines = pageToLines(content.items);
      let scanned = false;
      // Pages made of screenshots (e.g. a Canva file with pasted question pictures) have
      // no text layer at all: read them with OCR instead of silently skipping them.
      if (lines.join("").replace(/\s/g, "").length < 15) {
        try {
          const ocrLines = await ocrPdfPage(page, "PDF page " + p + " of " + pdf.numPages);
          if (ocrLines.length) {
            lines = ocrLines;
            scannedPages++;
          }
          scanned = true;
        } catch (err) {
          console.warn("OCR failed for PDF page " + p, err);
          if (p > 1) ocrErrors.push(p);
        }
      }
      pages.push({ page: page, num: p, lines: lines, scanned: scanned, isCover: isCoverLines(lines) });
    }

    // Page 1 with no numbered questions = cover page that fills the app's own cover
    let cover = null;
    if (wantSettingsCover && pages.length > 1 && !pages[0].lines.some((l) => Q_RE.test(l))) {
      cover = parseCover(pages[0].lines);
    }

    const norm = (s) => s.toLowerCase().replace(/\s+/g, "");
    const LECT_ONLY = /^lecture\d+(\+\d+)?$/;
    let subjectNorm = cover ? norm(cover.subject || "") : "";

    // repeated page header ("RS- pathology", "RS- pathology Lecture 2", "Lecture 3+ 4") or "Page 2"
    const isRepeatedHeader = (l) => {
      const n = norm(l);
      if (/^page\d+(of\d+|\/\d+)?$/.test(n)) return true;
      if (LECT_ONLY.test(n)) return true;
      if (subjectNorm && n.startsWith(subjectNorm)) {
        const rest = n.slice(subjectNorm.length);
        if (!rest || LECT_ONLY.test(rest)) return true;
      }
      return false;
    };

    const out = [];
    let coverCount = 0;
    let picturePages = 0;
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      if (cover && i === 0) continue;

      if (pg.isCover) {
        const info = parseCover(pg.lines);
        subjectNorm = norm(info.subject || "");
        const id = "p" + Date.now().toString(36) + "_" + coverCount + "_" + pg.num;
        try {
          const rendered = await renderPageImage(pg.page);
          window.pendingCoverPages[id] = {
            image: rendered.image,
            primaryColor: rendered.accent,
            label: (info.lecture || "Cover page") + " - cover (PDF page " + pg.num + ")",
            subject: info.subject || "",
            archive: info.archive || "Archive",
            lecture: info.lecture || "",
            topic: info.topic || "",
            collectedBy: info.collectedBy || "",
            editedBy: info.editedBy || "",
            correctedBy: info.correctedBy || "",
          };
          out.push("[[COVER:" + id + "]]");
          coverCount++;
        } catch (err) {
          console.warn("Could not render cover page " + pg.num, err);
        }
        continue;
      }

      // Picture-only page: keep the original page as a picture (photos, ✅ ticks and all),
      // followed by the OCR text so the questions can also be rebuilt as editable blocks.
      if (pg.scanned) {
        const id = "s" + Date.now().toString(36) + "_" + pg.num;
        try {
          const rendered = await renderPageImage(pg.page);
          window.pendingCoverPages[id] = {
            image: rendered.image,
            kind: "scan",
            useImage: true,
            label: "Original picture - PDF page " + pg.num,
          };
          out.push("[[COVER:" + id + "]]");
          picturePages++;
        } catch (err) {
          console.warn("Could not render PDF page " + pg.num, err);
        }
      }

      pg.lines.forEach((l) => {
        if (isRepeatedHeader(l)) return;
        out.push(l);
      });
    }
    if (ocrErrors.length && !out.length) {
      throw new Error("this PDF contains only pictures and the screenshot reader (OCR) could not read them - check your internet connection and try again");
    }
    return { text: out.join("\n"), cover: cover, coverCount: coverCount, scannedPages: scannedPages, picturePages: picturePages };
  }

  // Render a PDF page big and white-backed, then OCR it (English + Arabic)
  async function ocrPdfPage(page, label) {
    const worker = await getOcrWorker();
    ocrLabel = label;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, 2400 / base.width);
    const viewport = page.getViewport({ scale: scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport, background: "#fff" }).promise;
    return ocrCanvasLines(worker, canvas);
  }

  // Find a green tick (✅ / ✔) on a text line: a square-ish cluster of green pixels
  // inside the line's band, on the text or just to its right. Returns {x0,x1} or null.
  function findGreenTick(ctx, W, bbox) {
    const h = bbox.y1 - bbox.y0;
    if (h < 6) return null;
    const x0 = Math.max(0, bbox.x0);
    const x1 = Math.min(W, bbox.x1 + 3 * h);
    const w = x1 - x0;
    if (w <= 0) return null;
    let d;
    try {
      d = ctx.getImageData(x0, bbox.y0, w, h).data;
    } catch (e) {
      return null;
    }
    let n = 0, minX = Infinity, maxX = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (g > 140 && g - r > 50 && g - b > 30) {
          n++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    const width = maxX - minX + 1;
    if (n < h * h * 0.2 || width < h * 0.4 || width > h * 1.8) return null;
    return { x0: x0 + minX, x1: x0 + maxX };
  }

  // OCR a canvas line by line. Lines with a green tick get " ✅" at the end (the parser
  // turns that into the answer); the junk characters OCR makes of the tick are removed,
  // and lines that are only OCR noise (photos, borders) are dropped.
  async function ocrCanvasLines(worker, canvas) {
    const res = await worker.recognize(canvas);
    const data = (res && res.data) || {};
    const ctx = canvas.getContext("2d");
    let lines;
    if (Array.isArray(data.lines) && data.lines.length) {
      lines = data.lines.map((ln) => {
        let text = String(ln.text || "").replace(/\s+/g, " ").trim();
        const tick = ln.bbox ? findGreenTick(ctx, canvas.width, ln.bbox) : null;
        if (tick) {
          (ln.words || []).forEach((wd) => {
            const b = wd.bbox || {};
            const mid = (b.x0 + b.x1) / 2;
            if (mid >= tick.x0 - 5 && mid <= tick.x1 + 5) {
              const t = String(wd.text || "").trim();
              const k = t ? text.lastIndexOf(t) : -1;
              if (k !== -1) text = (text.slice(0, k) + text.slice(k + t.length)).replace(/\s+/g, " ").trim();
            }
          });
          text += " ✅";
        }
        // drop low-confidence junk at the end of an English line ("latent fingerprints “ee")
        if (!/[\u0600-\u06FF]/.test(text)) {
          const ws = (ln.words || []).slice().sort((a, b) => (b.bbox || {}).x0 - (a.bbox || {}).x0);
          for (const wd of ws) {
            const b = wd.bbox || {};
            if (tick && (b.x0 + b.x1) / 2 >= tick.x0 - 5) continue;
            const t = String(wd.text || "").trim();
            if ((wd.confidence || 0) >= 45 || !t) break;
            const k = text.lastIndexOf(t);
            if (k === -1 || k + t.length < text.replace(/\s*✅$/, "").length) break;
            text = (text.slice(0, k) + text.slice(k + t.length)).replace(/\s+/g, " ").trim();
          }
        }
        return { text: text, conf: ln.confidence || 0, tick: !!tick, bbox: ln.bbox };
      });
    } else {
      lines = String(data.text || "").split("\n").map((t) => ({ text: t.replace(/\s+/g, " ").trim(), conf: 100 }));
    }
    const kept = lines.filter((l) => {
      l.text = l.text
        .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
        .replace(/^[—–\-|*•\s]+(?=\S)/, "")
        .replace(/\s*[|{}\[\]]+(?=\s*(?:✅)?$)/, "")
        .trim();
      const letters = (l.text.match(/[A-Za-z\u0600-\u06FF]/g) || []).length;
      if (letters < 3) return false;
      if (l.conf < 50 && !l.tick) return false;
      // OCR noise from photos: many tiny "words" ("تا مت ا تت حا ا ا")
      const words = l.text.replace(/\s*✅$/, "").split(" ").filter(Boolean);
      if (words.length >= 4 && words.join("").length / words.length < 2.5) return false;
      return !isScreenshotHeader(l.text);
    });
    // A big vertical gap between two lines = a new screenshot box = a new question
    const out = [];
    kept.forEach((l, i) => {
      const prev = kept[i - 1];
      if (prev && prev.bbox && l.bbox) {
        const h = Math.max(prev.bbox.y1 - prev.bbox.y0, l.bbox.y1 - l.bbox.y0, 1);
        if (l.bbox.y0 - prev.bbox.y1 > h * 1.2) out.push("---");
      }
      out.push(l.text);
    });
    return out;
  }

  // ---------- Screenshots (OCR) ----------
  const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];
  let ocrWorker = null;
  let ocrLabel = "";

  async function getOcrWorker() {
    if (typeof Tesseract === "undefined") {
      throw new Error("Screenshot reader (OCR) did not load - check your internet connection and reload the page.");
    }
    if (!ocrWorker) {
      setStatus("Loading the screenshot reader (first time takes a few seconds)...");
      // Load both English and Arabic models so screenshots containing Arabic are read correctly.
      ocrWorker = await Tesseract.createWorker("eng+ara", 1, {
        logger: (m) => {
          if (m && m.status === "recognizing text") {
            setStatus("Reading " + ocrLabel + ": " + Math.round((m.progress || 0) * 100) + "%");
          }
        },
      });
    }
    return ocrWorker;
  }

  async function stopOcrWorker() {
    if (ocrWorker) {
      try {
        await ocrWorker.terminate();
      } catch (e) {}
      ocrWorker = null;
    }
  }

  // Load an image file onto a white canvas, enlarged if small (OCR is better on bigger text)
  async function imageFileToCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("Could not open the image"));
        i.src = url;
      });
      const scale = img.width < 1800 ? Math.min(3, 1800 / img.width) : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Page header lines like "RS- pathology Lecture 2" must not be glued onto an answer
  function isScreenshotHeader(l) {
    const n = l.toLowerCase().replace(/\s+/g, "");
    const subj = ((examData && examData.settings && examData.settings.subject) || "").toLowerCase().replace(/\s+/g, "");
    if (/^page\d+(of\d+|\/\d+)?$/.test(n)) return true;
    if (/^lecture\d+(\+\d+)?$/.test(n)) return true;
    if (subj && n.startsWith(subj) && /^(lecture\d+(\+\d+)?)?$/.test(n.slice(subj.length))) return true;
    return /^\S{1,12}-?\s*\S{1,15}\s+lecture\s*\d+(\s*\+\s*\d+)?$/i.test(l) && !/[?:]/.test(l);
  }

  async function readImage(file, label) {
    const worker = await getOcrWorker();
    ocrLabel = label;
    const canvas = await imageFileToCanvas(file);
    const lines = await ocrCanvasLines(worker, canvas);
    return lines.join("\n");
  }

  async function readDocx(file) {
    if (typeof mammoth === "undefined") {
      throw new Error("Word reader library did not load (check your internet connection).");
    }
    const buf = await file.arrayBuffer();
    const res = await mammoth.extractRawText({ arrayBuffer: buf });
    return res.value;
  }

  // "Q1." / "Q 1)" / "Question 1:" -> "1)"
  function normalizeText(text) {
    return text
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .map((l) => l.replace(/^(?:q(?:uestion)?\.?\s*)(\d+)\s*[\.\)\-:]?\s*/i, "$1) "))
      .filter((l) => l.length > 0)
      .join("\n");
  }

  function normalizeQuestion(q, i) {
    if (q && q.type === "cover" && q.image) {
      return makeCoverItem("j" + Date.now().toString(36) + i, q);
    }
    const type = q.type === "direct" || !q.choices || q.choices.length === 0 ? "direct" : "mcq";
    return {
      id: "q" + Date.now() + Math.random().toString(36).slice(2, 6) + i,
      number: String(q.number || i + 1),
      type: type,
      question: q.question || "",
      tag: q.tag || "",
      pageBreakAfter: !!q.pageBreakAfter,
      choices: Array.isArray(q.choices) ? q.choices : [],
      answer: q.answer || "",
      answerPrefix: q.answerPrefix !== undefined ? q.answerPrefix : type === "mcq" ? "Ans: " : "",
      sideNote: q.sideNote || "",
    };
  }

  function applyQuestions(list, replace) {
    const normalized = list.map(normalizeQuestion);
    examData.questions = replace ? normalized : examData.questions.concat(normalized);
    resequenceQuestionNumbers();
    saveData();
    renderEditor();
    renderPreview();
  }

  function applyCover(info) {
    const s = examData.settings;
    if (info.subject) s.subject = info.subject;
    if (info.archive) s.archiveBadge = info.archive;
    if (info.lecture) s.lectureNum = info.lecture;
    s.collectedBy = info.collectedBy || "";
    s.editedBy = info.editedBy || "";
    s.correctedBy = info.correctedBy || "";
    s.topic = info.topic || "";
    saveData();
    renderEditor();
    renderPreview();
  }

  // ---------- Main handler ----------
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const replaceCb = document.getElementById("bulkReplaceCb");
    const replace = replaceCb ? replaceCb.checked : false;
    const textParts = [];
    const problems = [];
    let cover = null;
    let coverTotal = 0;
    let shotCount = 0;
    let scannedTotal = 0;
    let pictureTotal = 0;
    let loadedJson = 0;

    // Screenshots take a while to read: open the import window so progress is visible
    // (PDFs too: a PDF made of screenshots is read with OCR page by page)
    if (files.some((f) => IMAGE_EXTS.indexOf(ext(f.name)) !== -1 || ext(f.name) === "pdf")) openBulkModal();

    setStatus("Reading " + files.length + " file(s)...");

    for (const file of files) {
      try {
        const e = ext(file.name);
        if (e === "json") {
          const data = JSON.parse(await file.text());
          if (data && data.settings && Array.isArray(data.questions)) {
            if (confirm('Load project "' + file.name + '"? This replaces the current document (settings + questions).')) {
              examData = data;
              resequenceQuestionNumbers();
              saveData();
              renderEditor();
              renderPreview();
              loadedJson++;
            }
          } else {
            const arr = Array.isArray(data) ? data : data && data.questions;
            if (!Array.isArray(arr)) throw new Error("JSON has no questions list");
            applyQuestions(arr, replace && loadedJson === 0);
            loadedJson++;
          }
        } else if (e === "docx") {
          textParts.push(await readDocx(file));
        } else if (e === "pdf") {
          const r = await readPdf(file, !cover);
          if (r.text.trim()) textParts.push(r.text);
          scannedTotal += r.scannedPages || 0;
          pictureTotal += r.picturePages || 0;
          coverTotal += r.coverCount || 0;
          if (r.cover && !cover) cover = r.cover;
        } else if (e === "txt" || e === "md" || e === "csv") {
          textParts.push(await file.text());
        } else if (IMAGE_EXTS.indexOf(e) !== -1) {
          shotCount++;
          const t = await readImage(file, "screenshot " + shotCount);
          if (t.trim()) textParts.push(t);
          else throw new Error("no text found in the screenshot");
        } else if (e === "doc") {
          throw new Error("Old .doc format is not supported. Save it as .docx or PDF first.");
        } else {
          throw new Error("Unsupported file type ." + e);
        }
      } catch (err) {
        problems.push(file.name + ": " + err.message);
      }
    }
    await stopOcrWorker();

    // Offer to copy the cover page details (subject, lecture, collected/edited by)
    if (cover) {
      const lines = [
        cover.subject && "Subject: " + cover.subject,
        cover.archive && "Badge: " + cover.archive,
        cover.lecture && "Lecture: " + cover.lecture,
        cover.collectedBy && "Collected by: " + cover.collectedBy,
        cover.editedBy && "Edited by: " + cover.editedBy,
        cover.correctedBy && "Corrected by: " + cover.correctedBy,
      ].filter(Boolean);
      if (confirm("A cover page was found in the file:\n\n" + lines.join("\n") + "\n\nUse these details for the cover page and page headers?")) {
        applyCover(cover);
      }
    }

    if (textParts.length) {
      const area = document.getElementById("bulkInputText");
      const combined = normalizeText(textParts.join("\n\n"));
      area.value = area.value.trim() ? area.value.trim() + "\n\n" + combined : combined;
      openBulkModal();
      setStatus(
        "Loaded " + textParts.length + " file(s)." +
          (coverTotal ? " Found " + coverTotal + " cover page(s) inside the file(s); they will be inserted in position (lines like [[COVER:...]] - keep them)." : "") +
          (shotCount ? " Screenshots are read automatically (OCR), so check the text for small mistakes." : "") +
          (pictureTotal
            ? " " + pictureTotal + " PDF page(s) were pictures: each one is kept as the original picture page (with its photos)." +
              (scannedTotal ? " Their text was read with OCR into the box below and becomes editable question blocks: green ✅ ticks are taken as the answers, and \"---\" marks a new screenshot box. OCR makes small mistakes, so check the questions." : "")
            : "") +
          " Check the text below, fix anything, then press \"Parse & Generate Blocks\"." +
          (problems.length ? " Problems: " + problems.join(" | ") : ""),
        problems.length > 0
      );
    } else if (loadedJson) {
      closeBulkModal();
      if (problems.length) alert(problems.join("\n"));
    } else {
      openBulkModal();
      setStatus(problems.join(" | ") || "Nothing was loaded.", true);
    }
  }

  // ---------- Wiring ----------
  document.addEventListener("DOMContentLoaded", () => {
    const input = document.getElementById("archiveFileInput");
    const headerBtn = document.getElementById("btnUploadArchive");
    const modalBtn = document.getElementById("btnPickArchive");
    const dropZone = document.getElementById("archiveDropZone");

    const pick = () => input && input.click();
    headerBtn && headerBtn.addEventListener("click", pick);
    modalBtn && modalBtn.addEventListener("click", pick);

    // Screenshot button (images only)
    const shotInput = document.getElementById("screenshotFileInput");
    const shotBtn = document.getElementById("btnUploadScreenshots");
    shotBtn && shotInput && shotBtn.addEventListener("click", () => shotInput.click());
    shotInput &&
      shotInput.addEventListener("change", (e) => {
        handleFiles(e.target.files);
        shotInput.value = "";
      });

    // Paste a screenshot straight from the clipboard (Ctrl+V / Cmd+V)
    document.addEventListener("paste", (e) => {
      const items = (e.clipboardData && e.clipboardData.files) || [];
      const imgs = Array.from(items).filter((f) => f.type && f.type.indexOf("image/") === 0);
      if (!imgs.length) return; // normal text paste: leave it alone
      e.preventDefault();
      const named = imgs.map((f, i) => {
        const extn = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
        return new File([f], "pasted-" + Date.now() + "-" + i + "." + extn, { type: f.type });
      });
      handleFiles(named);
    });

    input &&
      input.addEventListener("change", (e) => {
        handleFiles(e.target.files);
        input.value = "";
      });

    const targets = [dropZone, document.querySelector(".editor-pane")].filter(Boolean);
    targets.forEach((el) => {
      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        el.classList.add("drag-over");
      });
      el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("drag-over");
        handleFiles(e.dataTransfer.files);
      });
    });
  });

  window.handleArchiveFiles = handleFiles;
})();
