import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  startTransition
} from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "firebase/auth";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  updateDoc,
  writeBatch
} from "firebase/firestore";
import initialProjects from "./projects.json";
import { auth, db, firebaseConfigError } from "./firebase";
import "./App.css";

const STATUSES = [
  { id: "new", label: "New", hint: "Waiting to be picked up", accent: "var(--slate)" },
  {
    id: "active",
    label: "In Progress",
    hint: "Currently being worked on",
    accent: "var(--amber)"
  },
  {
    id: "review",
    label: "In Review",
    hint: "Ready for final review",
    accent: "var(--blue)"
  },
  {
    id: "delivered",
    label: "Closed",
    hint: "Completed and officially closed",
    accent: "var(--green)"
  }
];

const TEAM_MEMBERS = ["Abdullah"];
const OBSERVATIONS_COLLECTION = "observations";
const ROLE_BY_EMAIL = {
  "admin@riyadbank.com": "admin"
};
const ALLOWED_USERS = Object.keys(ROLE_BY_EMAIL);

function parseDueDate(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const [day, month, year] = value.split("/").map(Number);

  if (!day || !month || !year) {
    return null;
  }

  return new Date(year, month - 1, day);
}

function formatTimestamp(value) {
  if (!value) {
    return "Not captured yet";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function isOverdue(project) {
  if (project.status === "delivered") {
    return false;
  }

  const dueDate = parseDueDate(project.dueDate);

  if (!dueDate) {
    return false;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return dueDate < today;
}

function isDueThisMonth(project) {
  const dueDate = parseDueDate(project.dueDate);

  if (!dueDate) {
    return false;
  }

  const today = new Date();

  return (
    dueDate.getMonth() === today.getMonth() &&
    dueDate.getFullYear() === today.getFullYear()
  );
}

function buildHistoryEntry(message, actor) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    message,
    actor,
    createdAt: new Date().toISOString()
  };
}

function getRole(email) {
  return ROLE_BY_EMAIL[email ?? ""] ?? "viewer";
}

function getStatusCount(projects, statusId) {
  return projects.filter((project) => project.status === statusId).length;
}

function enrichObservation(project) {
  return {
    ...project,
    history: Array.isArray(project.history) ? project.history : [],
    attachmentUrl: project.attachmentUrl ?? "",
    attachmentLabel: project.attachmentLabel ?? "",
    lastUpdatedAt: project.lastUpdatedAt ?? "",
    lastUpdatedBy: project.lastUpdatedBy ?? "",
    details:
      project.details ??
      `${project.title} This observation is being tracked through the remediation dashboard.`
  };
}

function createEmptyObservation(nextId, actor) {
  return {
    id: nextId,
    name: `Observation ${nextId}`,
    title: "New observation title",
    client: "SailPoint",
    owner: TEAM_MEMBERS[0],
    status: "new",
    category: "Medium",
    progress: 10,
    risk: "Medium",
    dueDate: "31/12/2026",
    nextStep: "Add the first remediation update.",
    reference: "N/A",
    details: "Add the executive summary for this new observation.",
    attachmentUrl: "",
    attachmentLabel: "",
    lastUpdatedAt: new Date().toISOString(),
    lastUpdatedBy: actor,
    history: [buildHistoryEntry("Observation created", actor)]
  };
}

function deriveProgressFromStatus(status, currentProgress) {
  const baselines = {
    new: 10,
    active: 55,
    review: 85,
    delivered: 100
  };

  if (status === "delivered") {
    return 100;
  }

  return Math.max(currentProgress, baselines[status] ?? currentProgress);
}

function clampProgress(value) {
  const numeric = Number(value);

  if (Number.isNaN(numeric)) {
    return 0;
  }

  return Math.min(100, Math.max(0, numeric));
}

async function seedObservationsIfEmpty() {
  const observationsRef = collection(db, OBSERVATIONS_COLLECTION);
  const existingDocs = await getDocs(observationsRef);

  if (!existingDocs.empty) {
    return;
  }

  const batch = writeBatch(db);

  initialProjects.forEach((project) => {
    batch.set(doc(db, OBSERVATIONS_COLLECTION, String(project.id)), enrichObservation(project));
  });

  await batch.commit();
}

export default function App() {
  const [projects, setProjects] = useState(initialProjects.map(enrichObservation));
  const [selectedMember, setSelectedMember] = useState("All");
  const [selectedStatus, setSelectedStatus] = useState("All");
  const [selectedSeverity, setSelectedSeverity] = useState("All");
  const [selectedPlatform, setSelectedPlatform] = useState("All");
  const [selectedDueHealth, setSelectedDueHealth] = useState("All");
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [syncError, setSyncError] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [selectedObservationId, setSelectedObservationId] = useState(null);
  const [detailNote, setDetailNote] = useState("");

  const deferredSearch = useDeferredValue(search);

  useEffect(
    () =>
      firebaseConfigError || !auth
        ? () => {}
        :
      onAuthStateChanged(auth, (user) => {
        if (user && !ALLOWED_USERS.includes(user.email ?? "")) {
          setAuthError("This account is not allowed to access the dashboard.");
          void signOut(auth);
          setCurrentUser(null);
          setIsAuthReady(true);
          return;
        }

        setCurrentUser(user);
        setIsAuthReady(true);
      }),
    []
  );

  useEffect(() => {
    let isActive = true;

    if (!currentUser || !db || firebaseConfigError) {
      return () => {
        isActive = false;
      };
    }

    async function connectObservations() {
      try {
        await seedObservationsIfEmpty();

        const unsubscribe = onSnapshot(
          collection(db, OBSERVATIONS_COLLECTION),
          (snapshot) => {
            if (!isActive) {
              return;
            }

            const nextProjects = snapshot.docs
              .map((snapshotDoc) => enrichObservation(snapshotDoc.data()))
              .sort((left, right) => left.id - right.id);

            setProjects(nextProjects);
            setIsLoading(false);
            setSyncError("");
          },
          (error) => {
            if (!isActive) {
              return;
            }

            setIsLoading(false);
            setSyncError(error.message);
          }
        );

        return unsubscribe;
      } catch (error) {
        if (!isActive) {
          return undefined;
        }

        setIsLoading(false);
        setSyncError(error.message);
        return undefined;
      }
    }

    let unsubscribeListener;

    connectObservations().then((unsubscribe) => {
      unsubscribeListener = unsubscribe;
    });

    return () => {
      isActive = false;

      if (unsubscribeListener) {
        unsubscribeListener();
      }
    };
  }, [currentUser]);

  const platforms = useMemo(
    () => ["All", ...new Set(projects.map((project) => project.client))],
    [projects]
  );

  const severities = useMemo(
    () => ["All", ...new Set(projects.map((project) => project.category))],
    [projects]
  );

  const filteredProjects = useMemo(() => {
    if (!currentUser) {
      return [];
    }

    const normalizedSearch = deferredSearch.trim().toLowerCase();

    return projects.filter((project) => {
      const matchesMember =
        selectedMember === "All" || project.owner === selectedMember;
      const matchesStatus =
        selectedStatus === "All" || project.status === selectedStatus;
      const matchesSeverity =
        selectedSeverity === "All" || project.category === selectedSeverity;
      const matchesPlatform =
        selectedPlatform === "All" || project.client === selectedPlatform;
      const matchesDueHealth =
        selectedDueHealth === "All" ||
        (selectedDueHealth === "Overdue" && isOverdue(project)) ||
        (selectedDueHealth === "Due This Month" && isDueThisMonth(project)) ||
        (selectedDueHealth === "Open" && project.status !== "delivered") ||
        (selectedDueHealth === "Closed" && project.status === "delivered");
      const matchesSearch =
        !normalizedSearch ||
        project.name.toLowerCase().includes(normalizedSearch) ||
        project.client.toLowerCase().includes(normalizedSearch) ||
        project.title.toLowerCase().includes(normalizedSearch) ||
        project.nextStep.toLowerCase().includes(normalizedSearch) ||
        String(project.reference).toLowerCase().includes(normalizedSearch);

      return (
        matchesMember &&
        matchesStatus &&
        matchesSeverity &&
        matchesPlatform &&
        matchesDueHealth &&
        matchesSearch
      );
    });
  }, [
    currentUser,
    deferredSearch,
    projects,
    selectedDueHealth,
    selectedMember,
    selectedPlatform,
    selectedSeverity,
    selectedStatus
  ]);

  const sortedProjects = useMemo(() => {
    const statusOrder = { new: 0, active: 1, review: 2, delivered: 3 };

    return [...filteredProjects].sort((left, right) => {
      const leftClosed = left.status === "delivered";
      const rightClosed = right.status === "delivered";

      if (leftClosed !== rightClosed) {
        return leftClosed ? 1 : -1;
      }

      if (left.id !== right.id) {
        return left.id - right.id;
      }

      return statusOrder[left.status] - statusOrder[right.status];
    });
  }, [filteredProjects]);

  const summary = useMemo(() => {
    const delivered = getStatusCount(projects, "delivered");
    const active = getStatusCount(projects, "active");
    const review = getStatusCount(projects, "review");
    const overdue = projects.filter(isOverdue).length;
    const dueThisMonth = projects.filter(isDueThisMonth).length;
    const highRisk = projects.filter((project) => project.risk === "High").length;

    return [
      {
        label: "Total Observations",
        value: projects.length,
        note: "All audit observations in one dashboard"
      },
      {
        label: "Open Items",
        value: projects.filter((project) => project.status !== "delivered").length,
        note: "Still active on the remediation board"
      },
      {
        label: "In Review",
        value: review,
        note: "Waiting for closure validation"
      },
      {
        label: "Overdue",
        value: overdue,
        note: "Past due date and still open"
      },
      {
        label: "Due This Month",
        value: dueThisMonth,
        note: "Upcoming delivery pressure"
      },
      {
        label: "Needs Attention",
        value: highRisk,
        note: `${active} in progress, ${delivered} closed`
      }
    ];
  }, [projects]);

  const openCount = useMemo(
    () => projects.filter((project) => project.status !== "delivered").length,
    [projects]
  );

  const role = getRole(currentUser?.email);
  const isAdmin = role === "admin";
  const canEdit = Boolean(isAdmin);

  const selectedObservation = useMemo(
    () => projects.find((project) => project.id === selectedObservationId) ?? null,
    [projects, selectedObservationId]
  );

  const applyProjectPatch = async (projectId, buildNextProject) => {
    const currentProject = projects.find((project) => project.id === projectId);

    if (!currentProject || !currentUser?.email || !db) {
      return;
    }

    const nextProject = buildNextProject(currentProject);

    startTransition(() => {
      setProjects((currentProjects) =>
        currentProjects.map((project) =>
          project.id === projectId ? nextProject : project
        )
      );
    });

    try {
      await updateDoc(doc(db, OBSERVATIONS_COLLECTION, String(projectId)), nextProject);
      setSyncError("");
    } catch (error) {
      setSyncError(error.message);
    }
  };

  const updateProjectField = (projectId, field, value, message, extraPatch = {}) => {
    void applyProjectPatch(projectId, (currentProject) => {
      const actor = currentUser?.email ?? "Unknown";
      const history = [
        buildHistoryEntry(message, actor),
        ...currentProject.history
      ].slice(0, 20);

      const nextProgress =
        field === "status"
          ? deriveProgressFromStatus(value, currentProject.progress)
          : currentProject.progress;

      return {
        ...currentProject,
        ...extraPatch,
        [field]: value,
        progress: nextProgress,
        lastUpdatedAt: new Date().toISOString(),
        lastUpdatedBy: actor,
        history
      };
    });
  };

  const saveDetailNote = () => {
    if (!selectedObservation || !detailNote.trim()) {
      return;
    }

    const message = detailNote.trim();
    setDetailNote("");

    void applyProjectPatch(selectedObservation.id, (currentProject) => {
      const actor = currentUser?.email ?? "Unknown";
      const history = [
        buildHistoryEntry(`Added note: ${message}`, actor),
        ...currentProject.history
      ].slice(0, 20);

      return {
        ...currentProject,
        lastUpdatedAt: new Date().toISOString(),
        lastUpdatedBy: actor,
        history
      };
    });
  };

  const resetDashboard = async () => {
    if (!canEdit) {
      setSyncError("Only the admin account can reset Firebase data.");
      return;
    }

    if (!db) {
      setSyncError("Firebase is not configured yet.");
      return;
    }

    const confirmed = window.confirm(
      "Reset all observations back to the seed data? This will overwrite the current Firebase records."
    );

    if (!confirmed) {
      return;
    }

    try {
      const batch = writeBatch(db);

      initialProjects.forEach((project) => {
        batch.set(doc(db, OBSERVATIONS_COLLECTION, String(project.id)), enrichObservation(project));
      });

      await batch.commit();
      setSyncError("");
    } catch (error) {
      setSyncError(error.message);
    }
  };

  const createObservation = async () => {
    if (!canEdit || !db || !currentUser?.email) {
      setSyncError("Only the admin account can create observations.");
      return;
    }

    const nextId = projects.length > 0 ? Math.max(...projects.map((project) => project.id)) + 1 : 1;
    const nextObservation = createEmptyObservation(nextId, currentUser.email);

    startTransition(() => {
      setProjects((currentProjects) => [...currentProjects, nextObservation]);
      setSelectedObservationId(nextId);
    });

    try {
      await addDoc(collection(db, OBSERVATIONS_COLLECTION), nextObservation);
      setSyncError("");
    } catch (error) {
      setSyncError(error.message);
    }
  };

  const handleEmailSignIn = async (event) => {
    event.preventDefault();

    if (!auth || firebaseConfigError) {
      setAuthError(firebaseConfigError || "Firebase authentication is not configured.");
      return;
    }

    setIsSigningIn(true);
    setAuthError("");

    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      setSyncError("");
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    try {
      await signOut(auth);
      setSyncError("");
      setSelectedObservationId(null);
    } catch (error) {
      setSyncError(error.message);
    }
  };

  return (
    <div className="dashboard-shell">
      {firebaseConfigError ? (
        <section className="auth-gate">
          <div className="auth-gate-card">
            <span className="eyebrow">Configuration Needed</span>
            <h1>Dashboard setup is incomplete</h1>
            <p>
              The deployment is missing Firebase environment variables, so the app
              cannot connect yet.
            </p>
            <small>{firebaseConfigError}</small>
          </div>
        </section>
      ) : !isAuthReady ? (
        <section className="auth-gate">
          <div className="auth-gate-card">
            <span className="eyebrow">Secure Access</span>
            <h1>Checking your session...</h1>
            <p>Please wait while the dashboard verifies your login state.</p>
          </div>
        </section>
      ) : !currentUser ? (
        <section className="auth-gate">
          <div className="auth-gate-card">
            <span className="eyebrow">Secure Access</span>
            <h1>Sign in to access the dashboard</h1>
            <p>
              This dashboard is private. Only pre-approved users can sign in, and
              the admin account can make changes.
            </p>
            <form className="login-form" onSubmit={handleEmailSignIn}>
              <label>
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="Enter your email"
                  autoComplete="username"
                />
              </label>

              <label>
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                />
              </label>

              <button type="submit" className="primary-button" disabled={isSigningIn}>
                {isSigningIn ? "Signing in..." : "Sign In"}
              </button>
            </form>
            {authError ? <small>{authError}</small> : null}
          </div>
        </section>
      ) : (
        <>
          <header className="hero-panel">
            <div className="hero-copy">
              <img
                className="brand-logo"
                src="/riyad-bank-logo.webp"
                alt="Riyad Bank"
              />
              <span className="eyebrow">Audit Remediation Workspace</span>
              <h1>Audit Observations Tracker Dashboard</h1>
              <p>
                A polished workspace for tracking audit observations, due dates,
                evidence links, ownership, and every remediation update in one place.
              </p>
            </div>

            <div className="hero-side">
              <div className="hero-stat">
                <strong>{projects.length}</strong>
                <span>observations on the board</span>
              </div>
              <div className="hero-stat">
                <strong>{openCount}</strong>
                <span>open observations</span>
              </div>
              <div className="hero-stat">
                <strong>{projects.filter(isOverdue).length}</strong>
                <span>overdue observations</span>
              </div>
            </div>
          </header>

          <section className="summary-grid summary-grid-extended">
            {summary.map((item) => (
              <article key={item.label} className="summary-card">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.note}</small>
              </article>
            ))}
          </section>

          <section className="toolbar">
            <div className="toolbar-title">
              <h2>Filters and control</h2>
              <p>
                Ordered from Observation 1 on the left, while all closed items stay
                at the end.
              </p>
              <small>
                {isLoading
                  ? "Connecting to Firebase..."
                  : syncError
                    ? `Sync issue: ${syncError}`
                    : `Signed in as ${currentUser.email} | ${role.toUpperCase()}`}
              </small>
            </div>

            <div className="toolbar-controls toolbar-controls-extended">
              <label>
                <span>Search</span>
                <input
                  type="search"
                  placeholder="Search observation, platform, or reference"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>

              <label>
                <span>Owner</span>
                <select
                  value={selectedMember}
                  onChange={(event) => setSelectedMember(event.target.value)}
                >
                  <option value="All">All</option>
                  {TEAM_MEMBERS.map((member) => (
                    <option key={member} value={member}>
                      {member}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Status</span>
                <select
                  value={selectedStatus}
                  onChange={(event) => setSelectedStatus(event.target.value)}
                >
                  <option value="All">All</option>
                  {STATUSES.map((status) => (
                    <option key={status.id} value={status.id}>
                      {status.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Severity</span>
                <select
                  value={selectedSeverity}
                  onChange={(event) => setSelectedSeverity(event.target.value)}
                >
                  {severities.map((severity) => (
                    <option key={severity} value={severity}>
                      {severity}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Platform</span>
                <select
                  value={selectedPlatform}
                  onChange={(event) => setSelectedPlatform(event.target.value)}
                >
                  {platforms.map((platform) => (
                    <option key={platform} value={platform}>
                      {platform}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Due Health</span>
                <select
                  value={selectedDueHealth}
                  onChange={(event) => setSelectedDueHealth(event.target.value)}
                >
                  {["All", "Open", "Closed", "Overdue", "Due This Month"].map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>

              {canEdit ? (
                <button type="button" className="secondary-button" onClick={resetDashboard}>
                  Reset Firebase Data
                </button>
              ) : null}
              {canEdit ? (
                <button type="button" className="primary-button" onClick={createObservation}>
                  Create New Observation
                </button>
              ) : null}
            </div>

            <div className="auth-panel">
              <div className="auth-copy">
                <strong>{role === "admin" ? "Admin" : "Viewer"}</strong>
                <span>
                  {role === "admin"
                    ? "Full edit access is active."
                    : "Signed in without admin access. View-only mode is active."}
                </span>
              </div>
              <button type="button" className="primary-button" onClick={handleSignOut}>
                Sign Out
              </button>
            </div>
          </section>

          <section className="status-strip">
            {STATUSES.map((status) => (
              <article key={status.id} className="status-card">
                <div>
                  <h3>{status.label}</h3>
                  <p>{status.hint}</p>
                </div>
                <span
                  className="column-count"
                  style={{ backgroundColor: status.accent }}
                >
                  {getStatusCount(projects, status.id)}
                </span>
              </article>
            ))}
          </section>

          <section className="observation-grid">
            {sortedProjects.map((project) => (
              <article
                key={project.id}
                className={`project-card ${
                  project.status === "delivered" ? "project-card-closed" : ""
                }`}
              >
                <div className="project-topline">
                  <div className="project-topline-left">
                    <span className="observation-number">{project.name}</span>
                    <span
                      className="status-pill"
                      style={{
                        backgroundColor:
                          STATUSES.find((status) => status.id === project.status)?.accent
                      }}
                    >
                      {STATUSES.find((status) => status.id === project.status)?.label}
                    </span>
                    {isOverdue(project) ? <span className="alert-pill">Overdue</span> : null}
                  </div>
                  <span className="project-date">Due: {project.dueDate}</span>
                </div>

                {canEdit ? (
                  <div className="status-editor">
                    <label>
                      <span>Observation Status</span>
                      <select
                        value={project.status}
                        onChange={(event) =>
                          updateProjectField(
                            project.id,
                            "status",
                            event.target.value,
                            `Status changed to ${
                              STATUSES.find((status) => status.id === event.target.value)?.label
                            }`
                          )
                        }
                      >
                        {STATUSES.map((status) => (
                          <option key={status.id} value={status.id}>
                            {status.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}

                {canEdit ? (
                  <label className="editor-block">
                    <span>Observation</span>
                    <textarea
                      rows="4"
                      value={project.title}
                      onChange={(event) =>
                        updateProjectField(
                          project.id,
                          "title",
                          event.target.value,
                          "Observation description updated"
                        )
                      }
                    />
                  </label>
                ) : (
                  <div className="viewer-block">
                    <span>Observation</span>
                    <p>{project.title}</p>
                  </div>
                )}

                <dl className="project-meta">
                  <div>
                    <dt>Platform</dt>
                    <dd>{project.client}</dd>
                  </div>
                  <div>
                    <dt>Reference</dt>
                    <dd>{project.reference}</dd>
                  </div>
                  <div>
                    <dt>Severity</dt>
                    <dd>
                      <span className={`risk-chip risk-${project.risk.toLowerCase()}`}>
                        {project.category}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{project.owner}</dd>
                  </div>
                  <div>
                    <dt>Last Updated</dt>
                    <dd>{formatTimestamp(project.lastUpdatedAt)}</dd>
                  </div>
                  <div>
                    <dt>Updated By</dt>
                    <dd>{project.lastUpdatedBy || "Seed data"}</dd>
                  </div>
                </dl>

                {canEdit ? (
                  <label className="editor-block">
                    <span>Latest Update</span>
                    <textarea
                      rows="4"
                      value={project.nextStep}
                      onChange={(event) =>
                        updateProjectField(
                          project.id,
                          "nextStep",
                          event.target.value,
                          "Latest update refreshed"
                        )
                      }
                    />
                  </label>
                ) : (
                  <div className="viewer-block">
                    <span>Latest Update</span>
                    <p>{project.nextStep}</p>
                  </div>
                )}

                <div className="project-progress">
                  <div className="progress-line">
                    <span style={{ width: `${project.progress}%` }} />
                  </div>
                  <strong>{project.progress}%</strong>
                </div>

                <div className="project-card-footer">
                  {canEdit ? (
                    <div className="project-actions project-actions-single">
                      <label>
                        <span>Assign Owner</span>
                        <select
                          value={project.owner}
                          onChange={(event) =>
                            updateProjectField(
                              project.id,
                              "owner",
                              event.target.value,
                              `Owner changed to ${event.target.value}`
                            )
                          }
                        >
                          {TEAM_MEMBERS.map((member) => (
                            <option key={member} value={member}>
                              {member}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : (
                    <div className="view-only-banner">View only. Sign in to make changes.</div>
                  )}

                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setSelectedObservationId(project.id)}
                  >
                    View Details
                  </button>
                </div>
              </article>
            ))}

            {sortedProjects.length === 0 ? (
              <div className="empty-column">
                <strong>No observations found</strong>
                <span>Try adjusting the search or filter selection.</span>
              </div>
            ) : null}
          </section>

          {selectedObservation ? (
            <div className="details-backdrop" onClick={() => setSelectedObservationId(null)}>
              <aside
                className="details-panel"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="details-header">
                  <div>
                    <span className="eyebrow">Observation Details</span>
                    <h2>{selectedObservation.name}</h2>
                    <p>{selectedObservation.title}</p>
                  </div>
                  <div className="details-header-actions">
                    <span className={`role-badge role-badge-${role}`}>
                      {role === "admin" ? "Admin Access" : "View Only"}
                    </span>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setSelectedObservationId(null)}
                  >
                    Close
                  </button>
                  </div>
                </div>

                <div className="details-grid">
                  <div className="details-card">
                    <h3>Overview</h3>
                    {canEdit ? (
                      <label className="editor-block">
                        <span>Executive Summary</span>
                        <textarea
                          rows="4"
                          value={selectedObservation.details}
                          onChange={(event) =>
                            updateProjectField(
                              selectedObservation.id,
                              "details",
                              event.target.value,
                              "Observation overview updated"
                            )
                          }
                        />
                      </label>
                    ) : (
                      <p>{selectedObservation.details}</p>
                    )}
                    <dl className="details-meta">
                      <div>
                        <dt>Observation Name</dt>
                        <dd>
                          {canEdit ? (
                            <input
                              type="text"
                              value={selectedObservation.name}
                              onChange={(event) =>
                                updateProjectField(
                                  selectedObservation.id,
                                  "name",
                                  event.target.value,
                                  "Observation name updated"
                                )
                              }
                            />
                          ) : (
                            selectedObservation.name
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Status</dt>
                        <dd>
                          {canEdit ? (
                            <select
                              value={selectedObservation.status}
                              onChange={(event) =>
                                updateProjectField(
                                  selectedObservation.id,
                                  "status",
                                  event.target.value,
                                  `Status changed to ${
                                    STATUSES.find(
                                      (status) => status.id === event.target.value
                                    )?.label
                                  }`
                                )
                              }
                            >
                              {STATUSES.map((status) => (
                                <option key={status.id} value={status.id}>
                                  {status.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            STATUSES.find((status) => status.id === selectedObservation.status)?.label
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Due Date</dt>
                        <dd>
                          {canEdit ? (
                            <input
                              type="text"
                              value={selectedObservation.dueDate}
                              onChange={(event) =>
                                updateProjectField(
                                  selectedObservation.id,
                                  "dueDate",
                                  event.target.value,
                                  "Due date updated"
                                )
                              }
                            />
                          ) : (
                            selectedObservation.dueDate
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Owner</dt>
                        <dd>
                          {canEdit ? (
                            <select
                              value={selectedObservation.owner}
                              onChange={(event) =>
                                updateProjectField(
                                  selectedObservation.id,
                                  "owner",
                                  event.target.value,
                                  `Owner changed to ${event.target.value}`
                                )
                              }
                            >
                              {TEAM_MEMBERS.map((member) => (
                                <option key={member} value={member}>
                                  {member}
                                </option>
                              ))}
                            </select>
                          ) : (
                            selectedObservation.owner
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Platform</dt>
                        <dd>
                          {canEdit ? (
                            <input
                              type="text"
                              value={selectedObservation.client}
                              onChange={(event) =>
                                updateProjectField(
                                  selectedObservation.id,
                                  "client",
                                  event.target.value,
                                  "Platform updated"
                                )
                              }
                            />
                          ) : (
                            selectedObservation.client
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Reference</dt>
                        <dd>
                          {canEdit ? (
                            <input
                              type="text"
                              value={selectedObservation.reference}
                              onChange={(event) =>
                                updateProjectField(
                                  selectedObservation.id,
                                  "reference",
                                  event.target.value,
                                  "Reference updated"
                                )
                              }
                            />
                          ) : (
                            selectedObservation.reference
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Category</dt>
                        <dd>
                          {canEdit ? (
                            <input
                              type="text"
                              value={selectedObservation.category}
                              onChange={(event) =>
                                updateProjectField(
                                  selectedObservation.id,
                                  "category",
                                  event.target.value,
                                  "Category updated"
                                )
                              }
                            />
                          ) : (
                            selectedObservation.category
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Risk</dt>
                        <dd>
                          {canEdit ? (
                            <select
                              value={selectedObservation.risk}
                              onChange={(event) =>
                                updateProjectField(
                                  selectedObservation.id,
                                  "risk",
                                  event.target.value,
                                  "Risk updated"
                                )
                              }
                            >
                              {["Low", "Medium", "High"].map((riskLevel) => (
                                <option key={riskLevel} value={riskLevel}>
                                  {riskLevel}
                                </option>
                              ))}
                            </select>
                          ) : (
                            selectedObservation.risk
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Progress</dt>
                        <dd>
                          {canEdit ? (
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={selectedObservation.progress}
                              onChange={(event) =>
                                updateProjectField(
                                  selectedObservation.id,
                                  "progress",
                                  clampProgress(event.target.value),
                                  "Progress updated"
                                )
                              }
                            />
                          ) : (
                            `${selectedObservation.progress}%`
                          )}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="details-card">
                    <h3>Evidence Link</h3>
                    {canEdit ? (
                      <>
                        <label className="editor-block">
                          <span>Attachment URL</span>
                          <input
                            type="url"
                            value={selectedObservation.attachmentUrl}
                            onChange={(event) =>
                              updateProjectField(
                                selectedObservation.id,
                                "attachmentUrl",
                                event.target.value,
                                "Evidence link updated"
                              )
                            }
                            placeholder="https://..."
                          />
                        </label>
                        <label className="editor-block">
                          <span>Attachment Label</span>
                          <input
                            type="text"
                            value={selectedObservation.attachmentLabel}
                            onChange={(event) =>
                              updateProjectField(
                                selectedObservation.id,
                                "attachmentLabel",
                                event.target.value,
                                "Evidence label updated"
                              )
                            }
                            placeholder="Evidence package"
                          />
                        </label>
                      </>
                    ) : null}
                    {selectedObservation.attachmentUrl ? (
                      <a
                        className="evidence-link"
                        href={selectedObservation.attachmentUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {selectedObservation.attachmentLabel || "Open evidence link"}
                      </a>
                    ) : (
                      <p className="muted-copy">No evidence link added yet.</p>
                    )}
                  </div>

                  <div className="details-card details-card-wide">
                    <h3>Activity Timeline</h3>
                    {canEdit ? (
                      <div className="timeline-compose">
                        <textarea
                          rows="3"
                          value={detailNote}
                          onChange={(event) => setDetailNote(event.target.value)}
                          placeholder="Add a manual timeline note or review remark"
                        />
                        <button
                          type="button"
                          className="primary-button"
                          onClick={saveDetailNote}
                          disabled={!detailNote.trim()}
                        >
                          Add Note
                        </button>
                      </div>
                    ) : null}
                    <div className="timeline-list">
                      {selectedObservation.history.length > 0 ? (
                        selectedObservation.history.map((item) => (
                          <article key={item.id} className="timeline-item">
                            <strong>{item.message}</strong>
                            <span>{item.actor}</span>
                            <small>{formatTimestamp(item.createdAt)}</small>
                          </article>
                        ))
                      ) : (
                        <p className="muted-copy">No activity captured yet.</p>
                      )}
                    </div>
                  </div>
                </div>
              </aside>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
