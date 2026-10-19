# Offline project creation and build. The PowerShell entry validates all inputs.
if {$argc != 2} {error "Expected staged root and mode"}
set stage [file normalize [lindex $argv 0]]
set mode [lindex $argv 1]
if {$mode ni {synth-only full}} {error "Invalid build mode"}
set project [file join $stage project-final-008]
set report [file join $stage reports platform project-final-008]
if {[file exists $project] || [file exists $report]} {error "Project or reports already exist"}
file mkdir $report
file copy [file join $stage scripts build.tcl] [file join $report build.tcl.executed.tcl]
set argv [list $project $stage]
set argc 2
source [file join $stage scripts create_project.tcl]
close_project
if {$mode eq "synth-only"} {
    set argv [list $project synth-only]
    set argc 2
} else {
    set argv [list $project]
    set argc 1
}
source [file join $stage scripts build.tcl]
