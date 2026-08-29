const fs = require('fs');
const file = 'frontend/src/app/app/leads/page.tsx';
let content = fs.readFileSync(file, 'utf8');

const target = `<td className="px-4 py-3.5 whitespace-nowrap">
                      {getStageBadge(lead.leadStage, lead.score)}
                    </td>`;

const replacement = `<td className="px-4 py-3.5 whitespace-nowrap">
                      <div className="flex flex-col gap-1.5">
                        <div>{getStageBadge(lead.leadStage, lead.score)}</div>
                        {lead.capiEventsSent && lead.capiEventsSent.length > 0 && (
                          <div className="flex flex-wrap gap-1 max-w-[150px]">
                            {lead.capiEventsSent.map(ev => (
                              <span key={ev} className="inline-flex items-center text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200" title="Event CAPI Terkirim">
                                ✓ {ev}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </td>`;

content = content.replace(target, replacement);
fs.writeFileSync(file, content);
console.log('Patched frontend leads table');
