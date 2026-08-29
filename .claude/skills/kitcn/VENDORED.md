Vendored from the installed `kitcn` package's own `skills/kitcn` directory
(kitcn 0.32.1).

kitcn ships this skill inside its npm package rather than through the
`agent-skills` installer that manages the convex/* skills, so it is absent from
`skills-lock.json` and `npx convex ai-files install` will not refresh it.

To update after bumping kitcn:

    K=$(ls -d node_modules/.bun/kitcn@*/node_modules/kitcn | head -1)
    for dest in .claude/skills .agents/skills; do
      rm -rf $dest/kitcn && cp -R "$K/skills/kitcn" $dest/kitcn
    done

Then restore this file, and re-read `references/setup/index.md` — that is where
the project-layout expectations live, and they are what plan 015 tracks.
