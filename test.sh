mkdir -p worktest

#node ./apps/testagent/src/tools/cdp.ts
#pnpm build && pnpm testagent worktest --goal "create a tetris game, serve it at 0.0.0.0:1234 test it over cdp"
pnpm build && pnpm testagent worktest --goal "create a puzzle fighting game make it 3d using webgl with cool block shattering effects verify with screenshots over cdp. serve the game at 0.0.0.0:1234"
#pnpm testagent worktest3 --goal "create a 3d rts game with good looking buildings and units verify over cdp with screenshots"

