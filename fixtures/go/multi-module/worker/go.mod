module example.com/multi/worker

go 1.22

require (
	example.com/multi/api v0.0.0
	github.com/robfig/cron/v3 v3.0.1
)

replace example.com/multi/api => ../api
