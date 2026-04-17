import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  startTransition
} from "react";
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  updateDoc,
  writeBatch
} from "firebase/firestore";
import initialProjects from "./projects.json";
import { db } from "./firebase";
import "./App.css";

const STATUSES = [
  { id: "new", label: "New", hint: "Waiting to be picked up", accent: "var(--sky)" },
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

function getStatusCount(projects, statusId) {
  return projects.filter((project) => project.status === statusId).length;
}

async function seedObservationsIfEmpty() {
  const observationsRef = collection(db, OBSERVATIONS_COLLECTION);
  const existingDocs = await getDocs(observationsRef);

  if (!existingDocs.empty) {
    return;
  }

  const batch = writeBatch(db);

  initialProjects.forEach((project) => {
    batch.set(doc(db, OBSERVATIONS_COLLECTION, String(project.id)), project);
  });

  await batch.commit();
}

export default function App() {
  const [projects, setProjects] = useState(initialProjects);
  const [selectedMember, setSelectedMember] = useState("All");
  const [selectedStatus, setSelectedStatus] = useState("All");
  const [search, setSearch] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [syncError, setSyncError] = useState("");

  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    let isActive = true;

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
              .map((snapshotDoc) => snapshotDoc.data())
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
  }, []);

  const filteredProjects = useMemo(() => {
    const normalizedSearch = deferredSearch.trim().toLowerCase();

    return projects.filter((project) => {
      const matchesMember =
        selectedMember === "All" || project.owner === selectedMember;
      const matchesStatus =
        selectedStatus === "All" || project.status === selectedStatus;
      const matchesSearch =
        !normalizedSearch ||
        project.name.toLowerCase().includes(normalizedSearch) ||
        project.client.toLowerCase().includes(normalizedSearch) ||
        project.title.toLowerCase().includes(normalizedSearch) ||
        project.nextStep.toLowerCase().includes(normalizedSearch);

      return matchesMember && matchesStatus && matchesSearch;
    });
  }, [deferredSearch, projects, selectedMember, selectedStatus]);

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
    const highRisk = projects.filter((project) => project.risk === "High").length;

    return [
      {
        label: "Total Observations",
        value: projects.length,
        note: "All audit observations in one dashboard"
      },
      {
        label: "In Progress",
        value: active,
        note: "Observations with active remediation"
      },
      {
        label: "In Review",
        value: review,
        note: "Observations waiting for evidence review"
      },
      {
        label: "Closure Rate",
        value: `${projects.length ? Math.round((delivered / projects.length) * 100) : 0}%`,
        note: `${delivered} of ${projects.length} closed`
      },
      {
        label: "Needs Attention",
        value: highRisk,
        note: "High-severity or higher-risk items"
      }
    ];
  }, [projects]);

  const openCount = useMemo(
    () => projects.filter((project) => project.status !== "delivered").length,
    [projects]
  );

  const persistProjectUpdate = async (projectId, patch) => {
    try {
      await updateDoc(doc(db, OBSERVATIONS_COLLECTION, String(projectId)), patch);
      setSyncError("");
    } catch (error) {
      setSyncError(error.message);
    }
  };

  const updateProject = (projectId, field, value) => {
    startTransition(() => {
      setProjects((currentProjects) =>
        currentProjects.map((project) =>
          project.id === projectId ? { ...project, [field]: value } : project
        )
      );
    });

    void persistProjectUpdate(projectId, { [field]: value });
  };

  const resetDashboard = async () => {
    try {
      const batch = writeBatch(db);

      initialProjects.forEach((project) => {
        batch.set(doc(db, OBSERVATIONS_COLLECTION, String(project.id)), project);
      });

      await batch.commit();
      setSyncError("");
    } catch (error) {
      setSyncError(error.message);
    }
  };

  return (
    <div className="dashboard-shell">
      <header className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">Audit Remediation Workspace</span>
          <h1>Audit Observations Tracker Dashboard</h1>
          <p>
            A polished web dashboard for tracking audit observations, monitoring
            remediation status, and keeping due dates and submissions visible in
            one place.
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
            <strong>{getStatusCount(projects, "delivered")}</strong>
            <span>closed observations</span>
          </div>
        </div>
      </header>

      <section className="summary-grid">
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
            Ordered from Observation 1 on the left, while all closed items stay at
            the end.
          </p>
          <small>
            {isLoading
              ? "Connecting to Firebase..."
              : syncError
                ? `Sync issue: ${syncError}`
                : "All edits are now saved to Firebase."}
          </small>
        </div>

        <div className="toolbar-controls">
          <label>
            <span>Search</span>
            <input
              type="search"
              placeholder="Search observation or platform"
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

          <button type="button" className="secondary-button" onClick={resetDashboard}>
            Reset Firebase Data
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
              </div>
              <span className="project-date">Due: {project.dueDate}</span>
            </div>

            <label className="editor-block">
              <span>Observation</span>
              <textarea
                rows="4"
                value={project.title}
                onChange={(event) =>
                  updateProject(project.id, "title", event.target.value)
                }
              />
            </label>

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
            </dl>

            <label className="editor-block">
              <span>Latest Update</span>
              <textarea
                rows="4"
                value={project.nextStep}
                onChange={(event) =>
                  updateProject(project.id, "nextStep", event.target.value)
                }
              />
            </label>

            <div className="project-progress">
              <div className="progress-line">
                <span style={{ width: `${project.progress}%` }} />
              </div>
              <strong>{project.progress}%</strong>
            </div>

            <div className="project-actions">
              <label>
                <span>Assign Owner</span>
                <select
                  value={project.owner}
                  onChange={(event) =>
                    updateProject(project.id, "owner", event.target.value)
                  }
                >
                  {TEAM_MEMBERS.map((member) => (
                    <option key={member} value={member}>
                      {member}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Update Status</span>
                <select
                  value={project.status}
                  onChange={(event) =>
                    updateProject(project.id, "status", event.target.value)
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
          </article>
        ))}

        {sortedProjects.length === 0 ? (
          <div className="empty-column">
            <strong>No observations found</strong>
            <span>Try adjusting the search or filter selection.</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}
