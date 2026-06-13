defmodule SchedulerWeb.Endpoint do
  use Phoenix.Endpoint, otp_app: :scheduler

  plug Plug.Static, at: "/", from: :scheduler, gzip: false
  plug Plug.Parsers, parsers: [:json], pass: [], json_decoder: Jason
  plug SchedulerWeb.Router
end

defmodule SchedulerWeb.Router do
  use Phoenix.Router
  import Phoenix.Controller

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/api", SchedulerWeb do
    pipe_through :api
    get "/tasks", TaskController, :index
    post "/tasks", TaskController, :create
    post "/tasks/:id/retry", TaskController, :retry
    post "/tasks/:id/cancel", TaskController, :cancel
    get "/stats", TaskController, :stats
    get "/nodes", TaskController, :nodes
  end
end

defmodule SchedulerWeb.TaskController do
  use Phoenix.Controller, formats: [:json]

  defp serialize_task(task) do
    map = Map.from_struct(task)
    map
    |> Map.put(:priority, to_string(map.priority))
    |> Map.put(:status, to_string(map.status))
    |> Map.put(:expected_completion_at, if(map.expected_completion_at, do: DateTime.to_unix(map.expected_completion_at, :millisecond), else: nil))
    |> Map.put(:created_at, DateTime.to_unix(map.created_at, :millisecond))
    |> Map.put(:startedAt, if(Map.get(map, :started_at), do: DateTime.to_unix(map.started_at, :millisecond), else: nil))
    |> Map.put(:completedAt, if(Map.get(map, :completed_at), do: DateTime.to_unix(map.completed_at, :millisecond), else: nil))
    |> Map.put(:createdAt, map.created_at |> DateTime.to_unix(:millisecond))
  end

  def index(conn, _params) do
    tasks = Scheduler.TaskManager.list_tasks()
    json(conn, %{tasks: Enum.map(tasks, &serialize_task/1)})
  end

  def create(conn, %{"name" => name, "priority" => priority, "expectedCompletionAt" => expected_completion_at})
      when is_binary(name) and byte_size(name) > 0 and is_binary(priority) and priority in ~w(low medium high urgent) do
    priority_atom = String.to_existing_atom(priority)
    expected_at = if is_integer(expected_completion_at), do: DateTime.from_unix!(expected_completion_at, :millisecond), else: nil
    task = Scheduler.TaskManager.add_task(name, priority_atom, expected_at)
    json(conn, %{task: serialize_task(task)})
  end

  def create(conn, _params) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "Missing or invalid required fields: name, priority (low/medium/high/urgent), expectedCompletionAt (timestamp in ms)"})
  end

  def retry(conn, %{"id" => id}) do
    Scheduler.TaskManager.retry_task(id)
    json(conn, %{status: "ok"})
  end

  def cancel(conn, %{"id" => id}) do
    Scheduler.TaskManager.cancel_task(id)
    json(conn, %{status: "ok"})
  end

  def stats(conn, _params) do
    json(conn, Scheduler.TaskManager.get_stats())
  end

  def nodes(conn, _params) do
    nodes = for i <- 1..5 do
      %{
        id: "node-#{i}",
        name: if(i == 1, do: "scheduler-main", else: "worker-#{i - 1}"),
        type: if(i == 1, do: "scheduler", else: "worker"),
        status: if(:rand.uniform() > 0.1, do: "online", else: "overloaded"),
        cpu: 20 + :rand.uniform() * 60,
        memory: 30 + :rand.uniform() * 50,
        tasks: :rand.uniform(8),
        uptime: 3600 + :rand.uniform(86400)
      }
    end
    json(conn, %{nodes: nodes})
  end
end

defmodule SchedulerWeb.ErrorJSON do
  def render(template, _assigns) do
    %{errors: %{detail: Phoenix.Controller.status_message_from_template(template)}}
  end
end
