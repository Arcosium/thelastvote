import {GameAI} from '../../server/ai.mjs';
GameAI.prototype.opening=async function(owner,g){await new Promise(r=>setTimeout(r,180));g.openingDone=true;};
