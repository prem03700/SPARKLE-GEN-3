# Domain modules

Each workspace domain should own its domain-specific view model and use cases. Suggested domains: research, learning, coding, projects, R&D lab, simulation, and experiments. Domain modules must use shared contracts and request cross-domain work through an explicit handoff proposal. They must not create independent copies of shared memory, tasks, goals, or project state.

The current screens remain in `src/app.js` and should be extracted here incrementally with tests, not duplicated.
