(() => {
  "use strict";

  const config = window.UIU_SUPABASE_CONFIG || {};
  const ready = Boolean(
    window.supabase?.createClient &&
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(config.url || "") &&
    config.anonKey &&
    !String(config.anonKey).includes("YOUR_SUPABASE")
  );
  const client = ready ? window.supabase.createClient(config.url, config.anonKey) : null;
  const bucket = "uiu-routine-pdfs";
  const dayOrder = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const state = { catalog: [], picks: [], results: [], preview: null, admin: false, lastVisit: "", releaseKey: "", heartbeat: null, analytics: null, catalogPoll: null };

  const el = id => document.getElementById(id);
  const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
  const normalize = value => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const status = (id, message, type = "") => {
    const target = el(id);
    if (target) { target.className = target.className.split(" ")[0] + (type ? ` ${type}` : ""); target.textContent = message; }
  };
  const setCatalogStatus = (message, type = "") => status("routineCatalogState", message, type);
  const setPlannerStatus = (message, type = "") => status("routineStatus", message, type);
  const setAdminStatus = (message, type = "") => status("adminLoginStatus", message, type);
  const setPublishStatus = (message, type = "") => status("routinePublishStatus", message, type);
  const describeServiceError = error => {
    if (/invalid login credentials/i.test(error?.message || "")) {
      return "Supabase Auth rejected the email/password. This login does not create an account: create or reset the admin user in this project's Authentication → Users, then retry. Never add the password to site code.";
    }
    if (error?.code === "PGRST202" || /could not find the function public\.uiu_/i.test(error?.message || "")) {
      return "Supabase database setup is incomplete. Run the latest supabase-setup.sql in this project's SQL Editor to enable admin authorization and the dashboard.";
    }
    return error?.message || "An unexpected Supabase error occurred.";
  };

  async function ensureSession() {
    if (!client) throw new Error("Supabase is not configured. Add the project URL and public anon/publishable key to supabase-config.js.");
    let { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (!data.session) {
      const result = await client.auth.signInAnonymously();
      if (result.error) throw result.error;
      data = result.data;
    }
    return data.session;
  }

  window.trackSiteActivity = async (page, trackVisit = false) => {
    if (!client) return;
    try {
      await ensureSession();
      const shouldTrack = trackVisit && state.lastVisit !== page;
      const { error } = await client.rpc("uiu_track_site_activity", { p_page: page, p_track_visit: shouldTrack });
      if (error) throw error;
      if (shouldTrack) state.lastVisit = page;
    } catch (error) {
      console.error("Visitor activity tracking failed:", error);
    }
  };

  async function loadCatalog() {
    const { data, error } = await client.rpc("uiu_get_routine_catalog");
    if (error) throw error;
    const select = el("routineCourse");
    if (!data || !Array.isArray(data.courses) || !data.courses.length) {
      state.catalog = [];
      select.innerHTML = '<option value="">No published semester routine yet</option>';
      select.disabled = true;
      setCatalogStatus("The administrator has not published a semester routine yet.", "warn");
      return;
    }
    const releaseKey = `${data.semester || ""}|${data.updated_at || ""}`;
    const releaseChanged = Boolean(state.releaseKey && state.releaseKey !== releaseKey);
    state.releaseKey = releaseKey;
    if (releaseChanged) {
      state.picks = [];
      state.results = [];
      renderPicks();
      el("routineResults").innerHTML = '<div class="routine-empty">🗓️<strong>New semester routine available</strong>Choose your courses again to build an updated schedule.</div>';
      el("routineCount").textContent = "No routine generated yet";
      setPlannerStatus("The semester routine was updated. Please review and reselect your courses.", "ok");
    }
    const previousCourse = select.value;
    const previousFaculty = el("routineFaculty").value;
    state.catalog = data.courses;
    select.innerHTML = '<option value="">Select a course</option>' + state.catalog
      .map(course => `<option value="${escape(course.code)}">${escape(course.code)} — ${escape(course.name)}</option>`).join("");
    select.disabled = false;
    select.value = state.catalog.some(course => course.code === previousCourse) ? previousCourse : "";
    window.updateRoutineFacultyOptions();
    const currentCourse = state.catalog.find(course => course.code === select.value);
    if (currentCourse?.faculties.includes(previousFaculty)) el("routineFaculty").value = previousFaculty;
    el("routineAddCourse").disabled = false;
    setCatalogStatus(`${data.semester || "Current semester"} · ${state.catalog.length} courses · updated ${new Date(data.updated_at).toLocaleDateString()}`, "ok");
  }

  window.updateRoutineFacultyOptions = () => {
    const course = state.catalog.find(item => item.code === el("routineCourse").value);
    const faculty = el("routineFaculty");
    faculty.innerHTML = course
      ? '<option value="">Select your preferred faculty</option>' + course.faculties.map(name => `<option value="${escape(name)}">${escape(name)}</option>`).join("")
      : '<option value="">Choose a course first</option>';
    faculty.disabled = !course;
  };

  function renderPicks() {
    el("routinePicks").innerHTML = state.picks.map((pick, index) =>
      `<div class="course-pick"><div><strong>${escape(pick.code)} · ${escape(pick.course)}</strong><small>${escape(pick.faculty)}</small></div><button class="remove" aria-label="Remove ${escape(pick.code)}" onclick="removeRoutineCourse(${index})">×</button></div>`
    ).join("");
  };

  window.addRoutineCourse = () => {
    const code = el("routineCourse").value;
    const faculty = el("routineFaculty").value;
    const course = state.catalog.find(item => item.code === code);
    if (!course || !faculty) { setPlannerStatus("Select both a course and its preferred faculty first.", "warn"); return; }
    if (state.picks.some(pick => pick.code === code)) { setPlannerStatus("That course is already in your selection.", "warn"); return; }
    if (state.picks.length >= 12) { setPlannerStatus("You can select up to 12 subjects in one schedule.", "warn"); return; }
    state.picks.push({ code, course: course.name, faculty });
    el("routineCourse").value = "";
    window.updateRoutineFacultyOptions();
    renderPicks();
    setPlannerStatus("Course added. Add the rest of your subjects, then find conflict-free schedules.", "ok");
  };
  window.removeRoutineCourse = index => { state.picks.splice(index, 1); renderPicks(); };
  window.clearRoutinePicks = () => {
    state.picks = [];
    state.results = [];
    renderPicks();
    el("routineResults").innerHTML = '<div class="routine-empty">🗓️<strong>Ready for your schedule</strong>Add courses and generate routines.</div>';
    el("routineCount").textContent = "No routine generated yet";
    setPlannerStatus("Choose your subjects and preferred faculty to get started.");
  };

  function dayNames(text) {
    const source = String(text || "");
    return [
      ["Saturday", /(?:^|\W)(?:Saturday|Sat)(?=$|\W)/i],
      ["Sunday", /(?:^|\W)(?:Sunday|Sun)(?=$|\W)/i],
      ["Monday", /(?:^|\W)(?:Monday|Mon)(?=$|\W)/i],
      ["Tuesday", /(?:^|\W)(?:Tuesday|Tue)(?=$|\W)/i],
      ["Wednesday", /(?:^|\W)(?:Wednesday|Wed)(?=$|\W)/i],
      ["Thursday", /(?:^|\W)(?:Thursday|Thu)(?=$|\W)/i],
      ["Friday", /(?:^|\W)(?:Friday|Fri)(?=$|\W)/i]
    ].filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
  }
  function toMinutes(value) {
    const match = String(value || "").match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) return null;
    let hour = Number(match[1]), minute = Number(match[2] || 0);
    const meridiem = (match[3] || "").toUpperCase();
    if (minute > 59 || hour > 23 || (meridiem && hour > 12) || (meridiem && hour < 1)) return null;
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;
    return hour * 60 + minute;
  }
  function timeRange(text) {
    const match = String(text || "").replace(/[–—]/g, "-")
      .match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/i);
    if (!match) return null;
    let start = toMinutes(match[1]), end = toMinutes(match[2]);
    if (start === null || end === null) return null;
    if (end <= start && !/\b(?:AM|PM)\b/i.test(match[2]) && !/\b(?:AM|PM)\b/i.test(match[1]) && start < 720) end += 720;
    if (end <= start || end - start > 360) return null;
    return { start, end, label: `${match[1].trim()} - ${match[2].trim()}` };
  }
  function parsePdfTextItems(items) {
    const lines = new Map();
    for (const item of items) {
      const text = (item.str || "").trim();
      if (!text) continue;
      const y = Math.round(item.transform[5] / 3) * 3;
      if (!lines.has(y)) lines.set(y, []);
      lines.get(y).push({ x: item.transform[4], text });
    }
    const entries = [];
    for (const cells of lines.values()) {
      cells.sort((a, b) => a.x - b.x);
      const line = cells.map(cell => cell.text).join(" | ");
      const time = timeRange(line);
      const courseMatch = line.match(/\b[A-Z]{2,4}\s*-?\s*\d{2,4}[A-Z]?\b/i);
      const days = dayNames(line);
      if (!time || !courseMatch || !days.length) continue;
      const facultyCell = cells.find(cell => /\b(?:Dr\.?|Mr\.?|Ms\.?|Mrs\.?|Prof\.?)\s+[A-Za-z][A-Za-z .'-]{1,55}/i.test(cell.text));
      const facultyMatch = (facultyCell?.text || line).match(/\b(?:Dr\.?|Mr\.?|Ms\.?|Mrs\.?|Prof\.?)\s+[A-Za-z][A-Za-z .'-]{1,55}/i);
      if (!facultyMatch) continue;
      const code = courseMatch[0].replace(/\s+/g, " ").toUpperCase();
      const codeCell = cells.find(cell => courseMatch[0].includes(cell.text.trim()) || cell.text.toUpperCase().includes(code));
      const courseName = (codeCell?.text || "").replace(courseMatch[0], "").replace(/^[\s|:-]+|[\s|:-]+$/g, "").trim() || code;
      const section = line.match(/\b(?:sec(?:tion)?|class)\s*[:#-]?\s*([A-Za-z0-9-]{1,12})\b/i)?.[1] || "Default";
      entries.push({ code, course: courseName, faculty: facultyMatch[0].trim(), section, day: days.join(", "), days, start: time.start, end: time.end, time: time.label });
    }
    const seen = new Set();
    return entries.filter(entry => {
      const key = [entry.code, entry.faculty, entry.section, entry.days.join(","), entry.start, entry.end].join("|");
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  async function readRoutinePdf(file) {
    if (!window.pdfjsLib) throw new Error("PDF.js failed to load. Check the internet connection and reload.");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const entries = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      entries.push(...parsePdfTextItems(content.items));
    }
    return { entries, pages: pdf.numPages };
  }

  window.previewRoutinePdf = async event => {
    event.preventDefault();
    const file = el("adminRoutinePdf").files?.[0];
    if (!file) { setPublishStatus("Choose a routine PDF first.", "warn"); return; }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) { setPublishStatus("Upload a PDF file.", "warn"); return; }
    if (file.size > 25 * 1024 * 1024) { setPublishStatus("The PDF must be smaller than 25 MB.", "warn"); return; }
    const preview = el("routinePdfPreview");
    el("previewRoutineButton").disabled = true;
    el("publishRoutineButton").hidden = true;
    preview.hidden = true;
    state.preview = null;
    setPublishStatus("Reading the PDF and checking recognized class records…");
    try {
      const parsed = await readRoutinePdf(file);
      if (!parsed.entries.length) throw new Error("No complete course, faculty, day and time rows were recognized. Use a text-based routine PDF.");
      state.preview = { file, entries: parsed.entries };
      preview.replaceChildren();
      const summary = document.createElement("p");
      summary.textContent = `Recognized ${parsed.entries.length} class meetings across ${parsed.pages} pages and ${new Set(parsed.entries.map(row => row.code)).size} courses. Review the sample before publishing.`;
      preview.append(summary);
      const table = document.createElement("table");
      table.className = "routine-table";
      const head = document.createElement("thead");
      head.innerHTML = "<tr><th>Course</th><th>Section</th><th>Faculty</th><th>Day / time</th></tr>";
      const body = document.createElement("tbody");
      parsed.entries.slice(0, 100).forEach(row => {
        const tr = document.createElement("tr");
        [`${row.code} · ${row.course}`, row.section, row.faculty, `${row.day} · ${row.time}`].forEach(value => {
          const td = document.createElement("td"); td.textContent = value; tr.append(td);
        });
        body.append(tr);
      });
      table.append(head, body); preview.append(table);
      if (parsed.entries.length > 100) {
        const note = document.createElement("p"); note.textContent = `Showing the first 100 of ${parsed.entries.length} records.`; preview.append(note);
      }
      preview.hidden = false;
      el("publishRoutineButton").hidden = false;
      setPublishStatus("Review complete. Publish only if the detected records match the official timetable.", "ok");
    } catch (error) {
      console.error("Routine PDF review failed:", error);
      setPublishStatus(`Could not validate this PDF: ${error.message}`, "warn");
    } finally { el("previewRoutineButton").disabled = false; }
  };

  async function requireAdmin() {
    if (!client) throw new Error("Supabase is not configured.");
    const { data: { session }, error } = await client.auth.getSession();
    if (error) throw error;
    if (!session || session.user.is_anonymous) throw new Error("Sign in to an administrator account first.");
    const result = await client.rpc("uiu_is_admin");
    if (result.error) throw result.error;
    if (!result.data) throw new Error("This account is not authorized as an administrator.");
    return session;
  }
  async function loadCurrentRelease() {
    const target = el("adminCurrentRoutine");
    try {
      const { data, error } = await client.rpc("uiu_get_admin_routine");
      if (error) throw error;
      target.textContent = data
        ? `${data.semester} · ${data.entry_count} class meetings · published ${new Date(data.updated_at).toLocaleString()} · ${data.source_filename}`
        : "No semester routine has been published yet.";
    } catch (error) {
      console.error("Current routine lookup failed:", error);
      target.textContent = `Could not load the current routine: ${error.message}`;
    }
  }
  window.commitRoutineRelease = async () => {
    if (!state.preview) { setPublishStatus("Review the PDF before publishing.", "warn"); return; }
    const semester = el("routineSemester").value.trim();
    if (!semester) { setPublishStatus("Enter the semester name.", "warn"); return; }
    if (state.preview.entries.length > 12000) { setPublishStatus("The PDF has more than 12,000 detected class meetings.", "warn"); return; }
    const button = el("publishRoutineButton");
    button.disabled = true;
    let path = "";
    let published = false;
    try {
      const session = await requireAdmin();
      path = `${session.user.id}/${crypto.randomUUID()}.pdf`;
      setPublishStatus("Uploading the PDF to private storage…");
      const upload = await client.storage.from(bucket).upload(path, state.preview.file, { contentType: "application/pdf", upsert: false });
      if (upload.error) throw upload.error;
      setPublishStatus("Publishing the validated semester routine…");
      const { data, error } = await client.rpc("uiu_publish_routine", {
        p_semester: semester,
        p_source_filename: state.preview.file.name.slice(0, 255),
        p_source_path: path,
        p_entries: state.preview.entries
      });
      if (error) throw error;
      published = true;
      state.preview = null;
      el("routineReleaseForm").reset();
      el("routinePdfPreview").replaceChildren();
      el("routinePdfPreview").hidden = true;
      button.hidden = true;
      setPublishStatus(`Published ${data.entry_count} class meetings for ${data.semester}. Student planners will receive the updated catalog.`, "ok");
      try { await Promise.all([loadCatalog(), loadCurrentRelease()]); }
      catch (refreshError) {
        console.error("Published routine refresh failed:", refreshError);
        setPublishStatus(`Routine published, but this page could not refresh the catalog: ${refreshError.message}. Reload to verify.`, "warn");
      }
    } catch (error) {
      console.error("Routine publishing failed:", error);
      if (path && !published) {
        try {
          const cleanup = await client.storage.from(bucket).remove([path]);
          if (cleanup.error) console.error("Failed to remove unpublished PDF:", cleanup.error);
        } catch (cleanupError) {
          console.error("Failed to remove unpublished PDF:", cleanupError);
        }
      }
      setPublishStatus(`Routine was not published: ${error.message}`, "warn");
    } finally { button.disabled = false; }
  };

  window.signInAdmin = async event => {
    event.preventDefault();
    if (!client) { setAdminStatus("Configure Supabase first using supabase-config.js.", "warn"); return; }
    const button = el("adminSignInButton");
    button.disabled = true;
    try {
      const { error } = await client.auth.signInWithPassword({
        email: el("adminEmail").value.trim(),
        password: el("adminPassword").value
      });
      if (error) throw error;
      const { data, error: adminError } = await client.rpc("uiu_is_admin");
      if (adminError) throw adminError;
      if (!data) {
        const signOut = await client.auth.signOut();
        if (signOut.error) console.error("Rejected admin sign-out failed:", signOut.error);
        throw new Error("This account is not authorized as a toolkit administrator.");
      }
      await window.refreshAdminAccess();
    } catch (error) {
      console.error("Administrator sign-in failed:", error);
      setAdminStatus(`Sign-in failed: ${describeServiceError(error)}`, "warn");
    } finally { button.disabled = false; el("adminPassword").value = ""; }
  };
  window.refreshAdminAccess = async () => {
    if (!client) { el("adminLoginPanel").hidden = false; return false; }
    try {
      const { data: { session }, error } = await client.auth.getSession();
      if (error) throw error;
      if (!session || session.user.is_anonymous) {
        state.admin = false;
        el("adminLoginPanel").hidden = false; el("adminDashboard").hidden = true;
        return false;
      }
      const result = await client.rpc("uiu_is_admin");
      if (result.error) throw result.error;
      if (!result.data) {
        state.admin = false;
        el("adminLoginPanel").hidden = false; el("adminDashboard").hidden = true;
        return false;
      }
      state.admin = true;
      el("adminLoginPanel").hidden = true; el("adminDashboard").hidden = false;
      await Promise.all([loadCurrentRelease(), window.refreshAdminAnalytics()]);
      if (state.analytics) clearInterval(state.analytics);
      state.analytics = setInterval(() => {
        if (window.currentAppView === "admin" && state.admin) void window.refreshAdminAnalytics();
      }, 30000);
      return true;
    } catch (error) {
      console.error("Administrator authorization check failed:", error);
      setAdminStatus(`Could not verify administrator access: ${error.message}`, "warn");
      el("adminLoginPanel").hidden = false; el("adminDashboard").hidden = true;
      return false;
    }
  };
  window.signOutAdmin = async () => {
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) {
      console.error("Administrator sign-out failed:", error);
      status("adminAnalyticsStatus", `Could not sign out: ${error.message}`, "warn");
      return;
    }
    state.admin = false;
    if (state.analytics) clearInterval(state.analytics);
    el("adminDashboard").hidden = true;
    el("adminLoginPanel").hidden = false;
    setAdminStatus("You have signed out of the administrator dashboard.", "ok");
    try { await ensureSession(); } catch (sessionError) { console.error("Anonymous visitor session restore failed:", sessionError); }
  };
  window.refreshAdminAnalytics = async () => {
    if (!client || !state.admin) return;
    status("adminAnalyticsStatus", "Loading current statistics…");
    try {
      const { data, error } = await client.rpc("uiu_get_admin_analytics");
      if (error) throw error;
      el("adminActiveUsers").textContent = data.active_users;
      el("adminVisitsToday").textContent = data.visits_today;
      el("adminVisitorsToday").textContent = data.visitors_today;
      const top = el("adminTopPages"), active = el("adminActivePages");
      top.replaceChildren(); active.replaceChildren();
      (data.top_pages || []).forEach(row => {
        const tr = document.createElement("tr");
        [`${row.page}`, `${row.visits}`, `${row.visitors}`].forEach(value => { const td = document.createElement("td"); td.textContent = value; tr.append(td); });
        top.append(tr);
      });
      (data.active_pages || []).forEach(row => {
        const tr = document.createElement("tr");
        [`${row.page}`, `${row.users}`].forEach(value => { const td = document.createElement("td"); td.textContent = value; tr.append(td); });
        active.append(tr);
      });
      status("adminAnalyticsStatus", `Updated ${new Date().toLocaleTimeString()}`, "ok");
    } catch (error) {
      console.error("Analytics refresh failed:", error);
      status("adminAnalyticsStatus", `Could not load analytics: ${error.message}`, "warn");
    }
  };

  function conflicts(a, b) {
    const aDays = Array.isArray(a.days) ? a.days : [a.day];
    const bDays = Array.isArray(b.days) ? b.days : [b.day];
    return aDays.some(day => bDays.includes(day)) && a.start < b.end && b.start < a.end;
  }
  function score(sections) {
    const meetings = sections.flatMap(section => section.meetings);
    const days = new Set(meetings.flatMap(meeting => meeting.days || [meeting.day])).size;
    let gaps = 0;
    for (const day of dayOrder) {
      const onDay = meetings.filter(meeting => (meeting.days || [meeting.day]).includes(day)).sort((a, b) => a.start - b.start);
      for (let i = 1; i < onDay.length; i++) gaps += Math.max(0, onDay[i].start - onDay[i - 1].end);
    }
    const morning = meetings.filter(meeting => meeting.start < 720).length;
    const value = days * 35 + gaps * .08 - morning * 8;
    return { score: value, days, gaps, morning };
  }
  window.generateRoutines = async () => {
    if (!state.picks.length) { setPlannerStatus("Add at least one subject before generating your routine.", "warn"); return; }
    setPlannerStatus("Finding class-section combinations…");
    try {
      await ensureSession();
      const { data, error } = await client.rpc("uiu_get_selected_class_options", {
        p_selections: state.picks.map(({ code, faculty }) => ({ code, faculty }))
      });
      if (error) throw error;
      const options = state.picks.map((pick, index) => ({
        pick,
        sections: (data || []).filter(item => Number(item.position) === index + 1 && normalize(item.code) === normalize(pick.code) && normalize(item.faculty) === normalize(pick.faculty))
          .map(section => ({ ...section, meetings: (section.meetings || []).map(meeting => ({ ...meeting, days: Array.isArray(meeting.days) ? meeting.days : [meeting.day] })) }))
      }));
      const missing = options.filter(option => !option.sections.length).map(option => option.pick.code);
      if (missing.length) throw new Error(`No class sections found for ${missing.join(", ")}. Try a different faculty.`);
      const best = [];
      const bestLimit = 7;
      const nodeLimit = 200000;
      let nodes = 0, totalFound = 0;
      function walk(index, chosen) {
        if (nodes++ >= nodeLimit) return;
        if (index === options.length) {
          totalFound++;
          const candidate = { ...score(chosen), items: chosen.slice() };
          best.push(candidate);
          best.sort((a, b) => a.score - b.score);
          if (best.length > bestLimit) best.pop();
          return;
        }
        for (const section of options[index].sections) {
          if (!chosen.some(other => other.meetings.some(a => section.meetings.some(b => conflicts(a, b))))) walk(index + 1, [...chosen, section]);
          if (nodes >= nodeLimit) return;
        }
      }
      walk(0, []);
      state.results = best;
      if (!state.results.length) {
        setPlannerStatus("No conflict-free schedule is possible for these course/faculty choices. Try a different faculty or section.", "warn");
        window.renderRoutineResults();
        return;
      }
      setPlannerStatus(`Found ${totalFound}${nodes >= nodeLimit ? " or more" : ""} conflict-free schedules; showing the best ${state.results.length}.`, "ok");
      window.renderRoutineResults();
    } catch (error) {
      console.error("Routine generation failed:", error);
      setPlannerStatus(`Could not generate routines: ${error.message}`, "warn");
    }
  };
  window.renderRoutineResults = () => {
    const target = el("routineResults");
    el("routineCount").textContent = state.results.length ? `${state.results.length} possible routine${state.results.length === 1 ? "" : "s"}` : "No conflict-free routine";
    if (!state.results.length) {
      target.innerHTML = '<div class="routine-empty">⚠️<strong>No possible routine</strong>There is a time conflict between the selected classes.</div>';
      return;
    }
    target.innerHTML = state.results.map((result, index) => {
      const meetings = result.items.flatMap(section => section.meetings.map(meeting => ({ ...meeting, code: section.code, course: section.course, faculty: section.faculty, section: section.section })))
        .sort((a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day) || a.start - b.start);
      return `<div class="routine-card ${index === 0 ? "best" : ""}">${index === 0 ? '<div class="best-tag">★ RECOMMENDED</div>' : ""}
        <h3>Routine ${index + 1}</h3>
        <div class="routine-meta"><span>📅 ${result.days} days</span><span>⏱️ ${Math.round(result.gaps)} min gaps</span><span>🌅 ${result.morning} morning</span></div>
        <table class="routine-table"><thead><tr><th>Day</th><th>Time</th><th>Course / section</th><th>Faculty</th></tr></thead><tbody>
        ${meetings.map(meeting => (meeting.days || [meeting.day]).map(day => `<tr><td>${escape(day)}</td><td>${escape(meeting.time || `${meeting.start}–${meeting.end}`)}</td><td><strong>${escape(meeting.code)}</strong><br>${escape(meeting.course)} · ${escape(meeting.section)}</td><td>${escape(meeting.faculty || "—")}</td></tr>`).join("")).join("")}
        </tbody></table></div>`;
    }).join("");
  };
  window.printRoutineResults = () => {
    if (!state.results.length) { alert("Generate a routine first."); return; }
    window.print();
  };

  async function initialize() {
    renderPicks();
    if (!client) {
      const message = "Routine service is not connected. Set the Supabase URL and public anon/publishable key in supabase-config.js.";
      setCatalogStatus(message, "warn"); setPlannerStatus(message, "warn"); setAdminStatus(message, "warn");
      return;
    }
    try {
      let anonymousSessionAvailable = false;
      try {
        await ensureSession();
        anonymousSessionAvailable = true;
      } catch (error) {
        if (!/anonymous sign-ins are disabled/i.test(error.message)) throw error;
        console.warn("Supabase anonymous sign-ins are disabled; visitor tracking and student schedule requests are unavailable.");
        setPlannerStatus("Supabase anonymous sign-ins are disabled. Admin sign-in can still work, but enable anonymous sign-ins for student routine planning and analytics.", "warn");
      }
      if (anonymousSessionAvailable) {
        state.heartbeat = setInterval(() => {
          if (window.currentAppView === "admin") return;
          const page = window.currentAppView || "home";
          void window.trackSiteActivity(page, false);
        }, 30000);
        await window.trackSiteActivity(window.currentAppView || "home", true);
      }
      await loadCatalog();
      state.catalogPoll = setInterval(() => {
        void loadCatalog().catch(error => {
          console.error("Routine catalog refresh failed:", error);
          setCatalogStatus(`Could not check for a newer routine: ${error.message}`, "warn");
        });
      }, 60000);
      const { data: { session }, error } = await client.auth.getSession();
      if (error) throw error;
      if (session && !session.user.is_anonymous) await window.refreshAdminAccess();
    } catch (error) {
      console.error("Routine service initialization failed:", error);
      const message = describeServiceError(error);
      setCatalogStatus(message, "warn");
      setPlannerStatus(message, "warn");
      setAdminStatus(message, "warn");
    }
  }
  void initialize();
})();
