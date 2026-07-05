#!/usr/bin/env python3
"""Download remaining Toolathlon and AgencyBench task definitions after GitHub API rate limit resets."""
import json, urllib.request, base64, time, os, sys

BASE = "/mnt/d/code/deepanalyze/deepanalyze/benchmarks"

def fetch_json(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "DeepAnalyze-Bench/1.0"})
            resp = urllib.request.urlopen(req, timeout=30)
            return json.loads(resp.read())
        except Exception as e:
            if i < retries - 1:
                time.sleep(2 * (i + 1))
            else:
                raise

def fetch_file_content(url):
    data = fetch_json(url)
    return base64.b64decode(data['content']).decode()

def download_toolathlon():
    print("=== Downloading Toolathlon tasks ===")
    tasks_file = f"{BASE}/toolathlon-tasks/all-tasks.json"
    with open(tasks_file) as f:
        tasks = json.load(f)
    
    missing = [t for t in tasks if not t['prompt']]
    print(f"Tasks without prompts: {len(missing)}")
    
    for i, task in enumerate(missing):
        name = task['task_name']
        try:
            # Get task.md
            try:
                prompt = fetch_file_content(
                    f"https://api.github.com/repos/hkust-nlp/Toolathlon/contents/tasks/finalpool/{name}/docs/task.md"
                ).strip()
            except:
                prompt = ""
            
            # Get task_config.json
            try:
                config = json.loads(fetch_file_content(
                    f"https://api.github.com/repos/hkust-nlp/Toolathlon/contents/tasks/finalpool/{name}/task_config.json"
                ))
                tools = config.get('needed_mcp_servers', []) + config.get('needed_local_tools', [])
            except:
                tools = task.get('needed_tools', [])
            
            task['prompt'] = prompt
            task['needed_tools'] = tools
            
            if (i + 1) % 10 == 0:
                print(f"  Processed {i+1}/{len(missing)}")
                # Save progress
                with open(tasks_file, 'w', encoding='utf-8') as f:
                    json.dump(tasks, f, ensure_ascii=False, indent=2)
            
            time.sleep(1)
        except Exception as e:
            print(f"  Error: {name}: {e}")
    
    # Final save
    with open(tasks_file, 'w', encoding='utf-8') as f:
        json.dump(tasks, f, ensure_ascii=False, indent=2)
    
    with_prompt = sum(1 for t in tasks if t['prompt'])
    print(f"\nFinal: {with_prompt}/108 tasks have prompts")

def download_agencybench():
    print("\n=== Downloading AgencyBench tasks ===")
    output_dir = f"{BASE}/agencybench-tasks"
    os.makedirs(output_dir, exist_ok=True)
    
    capabilities = ["Game", "Frontend", "Backend", "Code", "Research", "MCP"]
    all_tasks = []
    
    for cap in capabilities:
        scenarios = fetch_json(
            f"https://api.github.com/repos/GAIR-NLP/AgencyBench/contents/AgencyBench-v2/{cap}"
        )
        scenario_dirs = [d['name'] for d in scenarios if d['type'] == 'dir']
        print(f"\n{cap}: {len(scenario_dirs)} scenarios")
        
        for scenario in scenario_dirs:
            try:
                files = fetch_json(
                    f"https://api.github.com/repos/GAIR-NLP/AgencyBench/contents/AgencyBench-v2/{cap}/{scenario}"
                )
                file_names = [f['name'] for f in files]
                
                task = {
                    "id": f"{cap}-{scenario}",
                    "capability": cap,
                    "scenario": scenario,
                    "files": file_names
                }
                
                # Try to read any description files
                for fobj in files:
                    fname = fobj['name']
                    if fname.lower() in ['readme.md', 'task.md', 'task.json', 'description.md', 'task.txt']:
                        try:
                            content = fetch_file_content(fobj['url'])
                            task['description_file'] = fname
                            task['description'] = content[:5000]
                        except:
                            pass
                
                all_tasks.append(task)
                time.sleep(0.5)
            except Exception as e:
                all_tasks.append({"id": f"{cap}-{scenario}", "capability": cap, "error": str(e)})
                print(f"  Error: {scenario}: {e}")
        
        time.sleep(1)
    
    with open(f"{output_dir}/all-tasks.json", 'w', encoding='utf-8') as f:
        json.dump(all_tasks, f, ensure_ascii=False, indent=2)
    
    print(f"\nTotal AgencyBench tasks: {len(all_tasks)}")

if __name__ == "__main__":
    download_toolathlon()
    download_agencybench()
    print("\nDone!")
